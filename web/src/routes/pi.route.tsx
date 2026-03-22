import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { Badge } from "~/components/ui/Badge";
import { piSessionStore, resetPiSessionStore, type SessionAccum } from "~/lib/pi-session-store";
import type {
  ChatTimelineItem,
  ChatTimelineTool,
  ConnectionState,
  DeliveryMode,
  ImageAttachment,
  JsonValue,
  MessageSource,
  StatusResponse,
  WsMessage,
} from "~/lib/types";
import { cn, createId, extractToolName } from "~/lib/utils";
import { fetchPiStatus } from "~/server/pi";

/* ── Status query options (shared between loader and component) ── */

const statusQueryOptions = {
  queryKey: ["status"] as const,
  queryFn: async () => {
    const res = await fetchPiStatus();
    return res as unknown as StatusResponse;
  },
  staleTime: 3_000,
};

export const Route = createFileRoute("/pi")({
  head: () => ({
    meta: [{ title: "Autonoma — Pi Agent" }],
  }),
  loader: async ({ context }) => {
    await context.queryClient.ensureQueryData(statusQueryOptions);
  },
  errorComponent: ({ error }) => (
    <div className="flex items-center justify-center h-full p-8 text-destructive">
      <p>Failed to load Pi status: {String(error)}</p>
    </div>
  ),
  component: PiLayoutRoute,
});

/* ── Deduplication helper ── */

export function mergeTimelines(
  loaderItems: ChatTimelineItem[],
  appendedItems: ChatTimelineItem[],
): ChatTimelineItem[] {
  if (appendedItems.length === 0) return loaderItems;
  const seen = new Set(loaderItems.map((item) => item.id));
  const unique = appendedItems.filter((item) => !seen.has(item.id));
  return [...loaderItems, ...unique];
}

/* ── Layout component ── */

function PiLayoutRoute() {
  const { apiClient, wsClient } = Route.useRouteContext();

  // Reset the store on mount so we start fresh
  useEffect(() => {
    resetPiSessionStore();
  }, []);

  // Status query — seeded by loader, polls client-side
  const statusQuery = useQuery({
    ...statusQueryOptions,
    refetchInterval: 5_000,
    retry: 1,
  });

  const orchestrators = statusQuery.data?.pi?.orchestrators ?? [];
  const defaultPi = statusQuery.data?.pi?.default;

  // Subscribe to all orchestrator sessions
  useEffect(() => {
    const sessionIds = orchestrators.map((o) => o.sessionId);
    for (const id of sessionIds) {
      wsClient.subscribeSession(id);
    }
    return () => {
      for (const id of sessionIds) {
        wsClient.unsubscribeSession(id);
      }
    };
  }, [wsClient, orchestrators.map((o) => o.sessionId).join(",")]);

  // WebSocket event subscription — routes events to correct session via store
  useEffect(() => {
    const store = piSessionStore;

    const unsubscribe = wsClient.subscribe((message: WsMessage) => {
      const sessionId = "sessionId" in message && message.sessionId ? message.sessionId : "default";

      if (message.type === "connected") {
        store.addPill("default", {
          id: "ws-connected",
          label: `WS ${message.clientId.slice(0, 8)}`,
        });
        return;
      }

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
          streamingText: (s.streamingText ?? "") + message.delta,
        }));
        return;
      }

      if (message.type === "message_end") {
        const content = message.content || "";

        if (message.role === "user") {
          if (content.trim()) {
            store.updateSession(sessionId, (s) => ({
              ...s,
              appendedItems: [
                ...s.appendedItems,
                {
                  id: createId("user"),
                  kind: "message",
                  role: "user",
                  content,
                  source: (message.source as MessageSource) ?? "web",
                  createdAt: message.timestamp ?? new Date().toISOString(),
                },
              ],
            }));
          }
          return;
        }

        store.updateSession(sessionId, (s) => {
          const next: SessionAccum = {
            ...s,
            streamingText: null,
          };
          if (content.trim()) {
            next.appendedItems = [
              ...s.appendedItems,
              {
                id: createId("assistant"),
                kind: "message",
                role: "assistant",
                content,
                createdAt: message.timestamp ?? new Date().toISOString(),
              },
            ];
          }
          return next;
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
          streamingText: null,
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
        store.addPill("default", {
          id: createId("error"),
          label: message.message,
          variant: "error",
        });
      }
    });

    const unsubscribeConnection = wsClient.subscribeConnection((state: ConnectionState) => {
      store.setConnectionState(state);
    });
    return () => {
      unsubscribe();
      unsubscribeConnection();
    };
  }, [wsClient]);

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

  const pathname = useRouterState({ select: (s) => s.location.pathname });

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
