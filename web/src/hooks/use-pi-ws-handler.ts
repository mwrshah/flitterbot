import { useEffect, useRef } from "react";
import type { AutonomaApiClient } from "~/lib/api";
import { piSessionStore, resetPiSessionStore } from "~/lib/pi-session-store";
import { StreamChunker } from "~/lib/stream-chunker";
import type {
  ChatTimelineTool,
  ConnectionState,
  DeliveryMode,
  ImageAttachment,
  JsonValue,
  MessageSource,
  WsMessage,
} from "~/lib/types";
import { createId, extractToolName } from "~/lib/utils";
import type { AutonomaWsClient } from "~/lib/ws";

/**
 * Routes WebSocket events into `piSessionStore` so any route (/, /pi, /pi/:id)
 * can consume real-time session updates. Must be called exactly once, in the
 * root layout, so the handler is always mounted regardless of active route.
 */
export function usePiWsHandler(
  wsClient: AutonomaWsClient,
  apiClient: AutonomaApiClient,
  defaultSessionId: string | undefined,
) {
  // Reset the store once on mount so we start fresh
  useEffect(() => {
    resetPiSessionStore();
  }, []);

  // StreamChunker instances keyed by messageId — buffers rapid text_delta events
  // and drains them at a controlled rate to reduce React re-renders.
  const chunkersRef = useRef<Map<string, { chunker: StreamChunker; flushedLength: number }>>(
    new Map(),
  );

  // WebSocket event subscription — routes events to correct session via store
  useEffect(() => {
    const store = piSessionStore;
    const chunkers = chunkersRef.current;

    const unsubscribe = wsClient.subscribe((message: WsMessage) => {
      const sessionId = "sessionId" in message && message.sessionId ? message.sessionId : undefined;

      if (message.type === "connected") {
        // Global pill — attach to default session if known, otherwise skip
        if (defaultSessionId) {
          store.addPill(defaultSessionId, {
            id: "ws-connected",
            label: `WS ${message.clientId.slice(0, 8)}`,
          });
        }
        return;
      }

      if (!sessionId) return;

      if (message.type === "queue_item_start") {
        const sourceLabel =
          message.item.source === "whatsapp"
            ? "WhatsApp"
            : message.item.source === "hook"
              ? "Hook"
              : message.item.source === "cron"
                ? "Cron"
                : "Web";
        store.addPill(sessionId, {
          id: `processing-${message.item.id}`,
          label: `Processing ${sourceLabel} message`,
          variant: message.item.source !== "web" ? "info" : undefined,
        });
        return;
      }

      if (message.type === "queue_item_end") {
        store.removePill(sessionId, `processing-${message.itemId}`);
        if (message.error) {
          store.addPill(sessionId, {
            id: `error-${message.itemId}`,
            label: message.error,
            variant: "error",
          });
        }
        return;
      }

      if (message.type === "text_delta") {
        const itemId = message.messageId;

        if (!chunkers.has(itemId)) {
          let flushedLength = 0;
          const chunker = new StreamChunker({
            onChunk: (fullText) => {
              const delta = fullText.slice(flushedLength);
              flushedLength = fullText.length;
              if (delta) {
                store.appendStreamingDelta(sessionId, itemId, delta);
              }
            },
          });
          chunkers.set(itemId, { chunker, flushedLength: 0 });

          if (import.meta.env.DEV) {
            (window as any).__streamChunker = chunker;
          }
        }

        chunkers.get(itemId)!.chunker.push(message.delta);
        return;
      }

      if (message.type === "thinking_delta") {
        store.appendStreamingThinkingDelta(sessionId, message.messageId, message.delta);
        return;
      }

      if (message.type === "toolcall_start") {
        store.startStreamingToolCall(sessionId, message.contentIndex, message.toolName ?? "tool");
        return;
      }

      if (message.type === "toolcall_delta") {
        store.appendStreamingToolCallDelta(sessionId, message.contentIndex, message.delta);
        return;
      }

      if (message.type === "message_end") {
        // Destroy chunker for this message
        const msgId = (message as any).messageId ?? message.message?.id;
        const entry = msgId ? chunkers.get(msgId) : undefined;
        if (entry && msgId) {
          entry.chunker.destroy();
          chunkers.delete(msgId);
          if (import.meta.env.DEV && (window as any).__streamChunker === entry.chunker) {
            (window as any).__streamChunker = null;
          }
        }

        const content = message.content || "";

        if (message.role === "user") {
          if (content.trim()) {
            store.updateSession(sessionId, (s) => {
              if (s.appendedItems.some((item) => item.id === message.messageId)) return s;
              return {
                ...s,
                appendedItems: [
                  ...s.appendedItems,
                  {
                    id: message.messageId,
                    kind: "message",
                    role: "user",
                    content,
                    source: (message.source as MessageSource) ?? "web",
                    workstreamName: message.workstreamName,
                    createdAt: message.timestamp ?? new Date().toISOString(),
                  },
                ],
              };
            });
          }
          return;
        }

        // Add completed message to timeline BEFORE clearing streaming state,
        // so the historical message renders before the streaming element hides.
        store.updateSession(sessionId, (s) => {
          if (content.trim()) {
            if (s.appendedItems.some((item) => item.id === message.messageId)) return s;
            return {
              ...s,
              appendedItems: [
                ...s.appendedItems,
                {
                  id: message.messageId,
                  kind: "message",
                  role: "assistant",
                  content,
                  blocks: message.blocks,
                  source: (message.source as MessageSource) ?? undefined,
                  workstreamName: message.workstreamName,
                  createdAt: message.timestamp ?? new Date().toISOString(),
                },
              ],
            };
          }
          return s;
        });
        store.clearStreamingState(sessionId);
        store.clearStreamingThinkingState(sessionId);
        store.clearStreamingToolCalls(sessionId);
        return;
      }

      if (message.type === "pi_surfaced") {
        // pi_surfaced confirms WhatsApp delivery — not used for timeline rendering.
        // The final assistant message is already in the timeline via message_end
        // with source: "pi_outbound" (set by subscribe.ts at turn_end).
        return;
      }

      if (message.type === "tool_execution_update") {
        store.updateSession(sessionId, (s) => {
          // Find matching tool_execution_start by toolUseId and update its result
          const idx = s.appendedItems.findIndex(
            (item) =>
              item.kind === "tool" &&
              item.toolUseId === message.toolUseId &&
              item.phase === "start",
          );
          if (idx >= 0) {
            const items = [...s.appendedItems];
            items[idx] = {
              ...(items[idx] as ChatTimelineTool),
              phase: "update",
              result: message.partialResult as JsonValue | undefined,
            };
            return { ...s, appendedItems: items };
          }
          return s;
        });
        return;
      }

      if (message.type === "tool_execution_start" || message.type === "tool_execution_end") {
        const eventRecord =
          message.event && typeof message.event === "object"
            ? (message.event as Record<string, unknown>)
            : undefined;

        const toolEvent: ChatTimelineTool = {
          id: message.id,
          kind: "tool",
          tool: message.tool || extractToolName(message.event),
          phase: message.type === "tool_execution_start" ? "start" : "end",
          toolUseId: message.toolUseId,
          args:
            message.type === "tool_execution_start"
              ? ((message.args ??
                  eventRecord?.arguments ??
                  eventRecord?.args ??
                  eventRecord?.toolArguments) as JsonValue | undefined)
              : undefined,
          result:
            message.type === "tool_execution_end"
              ? ((message.result ??
                  eventRecord?.result ??
                  eventRecord?.output ??
                  eventRecord?.toolResult) as JsonValue | undefined)
              : undefined,
          isError: message.type === "tool_execution_end" ? message.isError : undefined,
          createdAt: message.timestamp ?? new Date().toISOString(),
        };
        store.updateSession(sessionId, (s) => {
          if (s.appendedItems.some((item) => item.id === toolEvent.id)) return s;
          return { ...s, appendedItems: [...s.appendedItems, toolEvent] };
        });
        return;
      }

      if (message.type === "turn_end") {
        // Destroy all remaining chunkers for this session
        for (const [id, entry] of chunkers) {
          entry.chunker.destroy();
          chunkers.delete(id);
        }
        if (import.meta.env.DEV) {
          (window as any).__streamChunker = null;
        }

        store.clearStreamingState(sessionId);
        store.clearStreamingThinkingState(sessionId);
        store.clearStreamingToolCalls(sessionId);
        store.updateSession(sessionId, (s) => ({
          ...s,
          appendedItems: [
            ...s.appendedItems,
            {
              id: createId("divider-turn-end"),
              kind: "divider",
              createdAt: new Date().toISOString(),
            },
          ],
        }));
        return;
      }

      if (message.type === "error") {
        if (defaultSessionId) {
          store.addPill(defaultSessionId, {
            id: createId("error"),
            label: message.message,
            variant: "error",
          });
        }
      }
    });

    const unsubscribeConnection = wsClient.subscribeConnection((state: ConnectionState) => {
      store.setConnectionState(state);
    });
    return () => {
      unsubscribe();
      unsubscribeConnection();
      // Destroy all chunkers on cleanup
      for (const [, entry] of chunkers) {
        entry.chunker.destroy();
      }
      chunkers.clear();
    };
  }, [wsClient, defaultSessionId]);

  // Set initial connection state
  useEffect(() => {
    piSessionStore.setConnectionState(wsClient.connectionState);
  }, [wsClient]);

  // Register sendMessage on the store so any route can call it
  useEffect(() => {
    piSessionStore.setSendMessage(() => {
      return async (
        text: string,
        deliveryMode: DeliveryMode,
        images?: ImageAttachment[],
        targetSessionId?: string,
      ) => {
        try {
          await wsClient.sendMessage(text, deliveryMode, images, targetSessionId);
        } catch (wsError) {
          console.error("WS send failed, trying HTTP fallback:", wsError);
          try {
            await apiClient.sendMessage({
              text,
              source: "web",
              deliveryMode,
              images,
              targetSessionId,
            });
          } catch (httpError) {
            console.error("HTTP fallback also failed:", httpError);
            const sid = targetSessionId ?? "default";
            piSessionStore.addPill(sid, {
              id: createId("send-error"),
              label: "Failed to send message",
              variant: "error",
            });
          }
        }
      };
    });
  }, [wsClient, apiClient]);
}
