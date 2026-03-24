import { useEffect } from "react";
import type { AutonomaApiClient } from "~/lib/api";
import { piSessionStore, resetPiSessionStore, type SessionAccum } from "~/lib/pi-session-store";
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

  // Subscribe to wildcard so we receive all session-scoped events
  useEffect(() => {
    wsClient.subscribeSession("*");
    return () => {
      wsClient.unsubscribeSession("*");
    };
  }, [wsClient]);

  // WebSocket event subscription — routes events to correct session via store
  useEffect(() => {
    const store = piSessionStore;

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
        store.updateSession(sessionId, (s) => ({
          ...s,
          streamingMessageId: message.messageId,
          streamingText: (s.streamingText ?? "") + message.delta,
        }));
        return;
      }

      if (message.type === "message_end") {
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

        store.updateSession(sessionId, (s) => {
          const next: SessionAccum = {
            ...s,
            streamingText: null,
            streamingMessageId: null,
          };
          if (content.trim()) {
            if (s.appendedItems.some((item) => item.id === message.messageId)) return next;
            next.appendedItems = [
              ...s.appendedItems,
              {
                id: message.messageId,
                kind: "message",
                role: "assistant",
                content,
                source: (message.source as MessageSource) ?? undefined,
                workstreamName: message.workstreamName,
                createdAt: message.timestamp ?? new Date().toISOString(),
              },
            ];
          }
          return next;
        });
        return;
      }

      if (message.type === "pi_surfaced") {
        // pi_surfaced confirms WhatsApp delivery — not used for timeline rendering.
        // The final assistant message is already in the timeline via message_end
        // with source: "pi_outbound" (set by subscribe.ts at turn_end).
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
        store.updateSession(sessionId, (s) => ({
          ...s,
          streamingText: null,
          streamingMessageId: null,
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
