import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { Badge } from "~/components/ui/badge";
import { piSessionStore, resetPiSessionStore } from "~/lib/pi-session-store";
import { statusQueryOptions } from "~/lib/queries";
import type {
  ChatTimelineTool,
  ConnectionState,
  DeliveryMode,
  ImageAttachment,
  JsonValue,
  WsMessage,
} from "~/lib/types";
import { cn, createId, extractToolName } from "~/lib/utils";

export const Route = createFileRoute("/pi")({
  head: () => ({
    meta: [{ title: "Autonoma — Pi Agent" }],
  }),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(statusQueryOptions(context.apiClient));
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load Pi status: {String(error)}</p>
    </div>
  ),
  component: PiLayoutRoute,
});

/* ── Layout component ── */

function PiLayoutRoute() {
  const { apiClient, wsClient } = Route.useRouteContext();

  // Reset the store on mount so we start fresh
  useEffect(() => {
    resetPiSessionStore();
  }, []);

  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Status query — seeded by loader, invalidated via WebSocket (listener in root route)
  const statusQuery = useQuery({
    ...statusQueryOptions(apiClient),
    retry: 1,
  });

  const allOrchestrators = statusQuery.data?.pi?.orchestrators ?? [];
  const defaultPi = statusQuery.data?.pi?.default;
  const workstreams = statusQuery.data?.workstreams ?? [];

  // Build set of open workstream IDs
  const openWsIds = new Set(workstreams.filter((w) => w.status === "open").map((w) => w.id));

  // Persistent tabs: only orchestrators with open workstreams
  const openOrchestrators = allOrchestrators.filter((o) => openWsIds.has(o.workstreamId));

  // Ephemeral tab: if current URL points to a closed workstream's orchestrator, include it
  const currentSessionId = pathname.startsWith("/pi/") ? pathname.split("/")[2] : null;
  const ephemeralOrchestrator =
    currentSessionId && currentSessionId !== "default"
      ? allOrchestrators.find(
          (o) => o.sessionId === currentSessionId && !openWsIds.has(o.workstreamId),
        )
      : undefined;

  const orchestrators = ephemeralOrchestrator
    ? [...openOrchestrators, ephemeralOrchestrator]
    : openOrchestrators;

  // Subscribe to default agent + all orchestrator sessions
  const defaultSessionId = defaultPi?.sessionId;
  useEffect(() => {
    const sessionIds = allOrchestrators.map((o) => o.sessionId);
    if (defaultSessionId) {
      sessionIds.push(defaultSessionId);
    }
    for (const id of sessionIds) {
      wsClient.subscribeSession(id);
    }
    return () => {
      for (const id of sessionIds) {
        wsClient.unsubscribeSession(id);
      }
    };
  }, [wsClient, defaultSessionId, allOrchestrators.map((o) => o.sessionId).join(",")]);

  // WebSocket event subscription — routes events to correct session via store
  useEffect(() => {
    const store = piSessionStore;

    const unsubscribe = wsClient.subscribe((message: WsMessage) => {
      const sessionId =
        "sessionId" in message && message.sessionId ? message.sessionId : undefined;

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
        store.updateSession(sessionId, (s) => {
          const existing = s.appendedItems.find((item) => item.id === itemId);
          if (existing && existing.kind === "message") {
            return {
              ...s,
              appendedItems: s.appendedItems.map((item) =>
                item.id === itemId && item.kind === "message"
                  ? { ...item, content: item.content + message.delta }
                  : item,
              ),
            };
          }
          // First delta with this messageId — create a streaming timeline item
          return {
            ...s,
            appendedItems: [
              ...s.appendedItems,
              {
                id: itemId,
                kind: "message" as const,
                role: "assistant" as const,
                content: message.delta,
                streaming: true,
                createdAt: new Date().toISOString(),
              },
            ],
          };
        });
        return;
      }

      if (message.type === "message_end") {
        const msg = message.message;
        if (!msg.content.trim()) return;

        store.updateSession(sessionId, (s) => {
          const existingIdx = s.appendedItems.findIndex((item) => item.id === msg.id);
          if (existingIdx >= 0) {
            // Finalize: the streaming text_delta already created this item — replace with full message
            return {
              ...s,
              appendedItems: s.appendedItems.map((item, idx) =>
                idx === existingIdx ? msg : item,
              ),
            };
          }
          // New message (user or non-streamed assistant) — push directly
          return {
            ...s,
            appendedItems: [...s.appendedItems, msg],
          };
        });
        return;
      }

      if (message.type === "tool_execution_start" || message.type === "tool_execution_end") {
        const eventRecord =
          message.event && typeof message.event === "object"
            ? (message.event as Record<string, unknown>)
            : undefined;

        const toolEvent: ChatTimelineTool = {
          id: createId("tool"),
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
        store.updateSession(sessionId, (s) => ({
          ...s,
          appendedItems: [...s.appendedItems, toolEvent],
        }));
        return;
      }

      if (message.type === "turn_end") {
        store.updateSession(sessionId, (s) => ({
          ...s,
          appendedItems: [
            // Safety: clear any lingering streaming flags
            ...s.appendedItems.map((item) =>
              item.kind === "message" && item.streaming
                ? { ...item, streaming: undefined }
                : item,
            ),
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

  // Register sendMessage on the store so child routes can call it
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

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-border shrink-0 overflow-x-auto">
        <TabLink to="/pi/default" active={pathname === "/pi/default" || pathname === "/pi"}>
          Default
          {defaultPi?.busy && <Badge variant="success">active</Badge>}
        </TabLink>
        {orchestrators.map((o) => (
          <TabLink
            key={o.sessionId}
            to={`/pi/${o.sessionId}`}
            active={pathname === `/pi/${o.sessionId}`}
          >
            {o.workstreamName ?? o.workstreamId}
            {o.busy && <Badge variant="success">active</Badge>}
          </TabLink>
        ))}
      </div>

      {/* Child route renders here */}
      <div className="flex-1 min-h-0">
        <Outlet />
      </div>
    </div>
  );
}

/* ── Tab link component ── */

function TabLink({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={cn(
        "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap",
        active
          ? "bg-accent text-accent-foreground font-medium"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {children}
    </Link>
  );
}
