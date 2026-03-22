import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Link, Outlet, createFileRoute, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useControlSurface } from "~/hooks/use-control-surface";
import { Badge } from "~/components/ui/Badge";
import type { ChatTimelineItem, ChatTimelineTool, ConnectionState, WsMessage } from "~/lib/types";
import type { MessageSource, DeliveryMode, ImageAttachment } from "~/lib/types";
import { createId, extractToolName } from "~/lib/utils";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/pi")({
  head: () => ({
    meta: [{ title: "Autonoma — Pi Agent" }],
  }),
  component: PiLayoutRoute,
});

/* ── Session timeline state managed per-session ── */

type StatusPill = { id: string; label: string; variant?: "info" | "error" };

type SessionState = {
  timeline: ChatTimelineItem[];
  streamingText: string | null;
  statusPills: StatusPill[];
  hydrated: boolean;
};

function emptySession(): SessionState {
  return { timeline: [], streamingText: null, statusPills: [], hydrated: false };
}

/* ── Context for child routes ── */

type PiSessionContextValue = {
  getSessionState: (sessionId: string) => SessionState;
  sendMessage: (
    text: string,
    deliveryMode: DeliveryMode,
    images?: ImageAttachment[],
    targetSessionId?: string,
  ) => Promise<void>;
  connectionState: ConnectionState;
};

const PiSessionContext = createContext<PiSessionContextValue | null>(null);

export function usePiSession(): PiSessionContextValue {
  const value = useContext(PiSessionContext);
  if (!value) {
    throw new Error("usePiSession must be used within PiLayoutRoute");
  }
  return value;
}

/* ── Layout component ── */

function PiLayoutRoute() {
  const { apiClient, wsClient } = useControlSurface();

  // Session state map: "default" key for default session, sessionId for orchestrators
  const sessionsRef = useRef(new Map<string, SessionState>());
  const [, forceUpdate] = useState(0);
  const rerender = useCallback(() => forceUpdate((n) => n + 1), []);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    wsClient.connectionState,
  );

  // Status query for tab bar
  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: () => apiClient.getStatus(),
    refetchInterval: 5_000,
    retry: 1,
  });

  const orchestrators = statusQuery.data?.pi?.orchestrators ?? [];
  const defaultPi = statusQuery.data?.pi?.default;

  // Helpers to mutate session state
  const getSession = useCallback((sessionId: string): SessionState => {
    let session = sessionsRef.current.get(sessionId);
    if (!session) {
      session = emptySession();
      sessionsRef.current.set(sessionId, session);
    }
    return session;
  }, []);

  const updateSession = useCallback(
    (sessionId: string, updater: (s: SessionState) => SessionState) => {
      const current = getSession(sessionId);
      sessionsRef.current.set(sessionId, updater(current));
      rerender();
    },
    [getSession, rerender],
  );

  const addPill = useCallback(
    (sessionId: string, pill: StatusPill) => {
      updateSession(sessionId, (s) => ({
        ...s,
        statusPills: [...s.statusPills.filter((p) => p.id !== pill.id), pill].slice(-6),
      }));
    },
    [updateSession],
  );

  const removePill = useCallback(
    (sessionId: string, id: string) => {
      updateSession(sessionId, (s) => ({
        ...s,
        statusPills: s.statusPills.filter((p) => p.id !== id),
      }));
    },
    [updateSession],
  );

  // Hydrate history for a session (only once)
  const hydrateSession = useCallback(
    (sessionId: string) => {
      const session = getSession(sessionId);
      if (session.hydrated) return;
      // Mark hydrated immediately to prevent duplicate calls
      sessionsRef.current.set(sessionId, { ...session, hydrated: true });

      const piSessionId = sessionId === "default" ? undefined : sessionId;
      void apiClient
        .getPiHistory(undefined, piSessionId)
        .then((history) => {
          updateSession(sessionId, (s) => ({
            ...s,
            timeline: [...history.items, ...s.timeline],
          }));
        })
        .catch(() => {});
    },
    [apiClient, getSession, updateSession],
  );

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

  // Hydrate default session immediately, and orchestrator sessions as they appear
  useEffect(() => {
    hydrateSession("default");
  }, [hydrateSession]);

  useEffect(() => {
    for (const o of orchestrators) {
      hydrateSession(o.sessionId);
    }
  }, [orchestrators, hydrateSession]);

  // WebSocket event subscription — routes events to correct session
  useEffect(() => {
    const unsubscribe = wsClient.subscribe((message: WsMessage) => {
      // Determine which session this message belongs to
      const sessionId =
        "sessionId" in message && message.sessionId
          ? message.sessionId
          : "default";

      if (message.type === "connected") {
        addPill("default", {
          id: "ws-connected",
          label: `WS ${message.clientId.slice(0, 8)}`,
        });
        return;
      }

      if (message.type === "queue_item_start") {
        const sourceLabel =
          message.item.source === "whatsapp" ? "WhatsApp" :
          message.item.source === "hook" ? "Hook" :
          message.item.source === "cron" ? "Cron" : "Web";
        addPill(sessionId, {
          id: `processing-${message.item.id}`,
          label: `Processing ${sourceLabel} message`,
          variant: message.item.source !== "web" ? "info" : undefined,
        });
        return;
      }

      if (message.type === "queue_item_end") {
        removePill(sessionId, `processing-${message.itemId}`);
        if (message.error) {
          addPill(sessionId, {
            id: `error-${message.itemId}`,
            label: message.error,
            variant: "error",
          });
        }
        return;
      }

      if (message.type === "text_delta") {
        updateSession(sessionId, (s) => ({
          ...s,
          streamingText: (s.streamingText ?? "") + message.delta,
        }));
        return;
      }

      if (message.type === "message_end") {
        const content = message.content || "";

        if (message.role === "user") {
          if (content.trim()) {
            updateSession(sessionId, (s) => ({
              ...s,
              timeline: [
                ...s.timeline,
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

        updateSession(sessionId, (s) => {
          const next: SessionState = {
            ...s,
            streamingText: null,
          };
          if (content.trim()) {
            next.timeline = [
              ...s.timeline,
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

      if (
        message.type === "tool_execution_start" ||
        message.type === "tool_execution_end"
      ) {
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
              ? (message.args ??
                eventRecord?.arguments ??
                eventRecord?.args ??
                eventRecord?.toolArguments)
              : undefined,
          result:
            message.type === "tool_execution_end"
              ? (message.result ??
                eventRecord?.result ??
                eventRecord?.output ??
                eventRecord?.toolResult)
              : undefined,
          isError:
            message.type === "tool_execution_end"
              ? message.isError
              : undefined,
          createdAt: message.timestamp ?? new Date().toISOString(),
        };
        updateSession(sessionId, (s) => ({
          ...s,
          timeline: [...s.timeline, toolEvent],
        }));
        return;
      }

      if (message.type === "turn_end") {
        updateSession(sessionId, (s) => ({
          ...s,
          streamingText: null,
          timeline: [
            ...s.timeline,
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
        addPill("default", {
          id: createId("error"),
          label: message.message,
          variant: "error",
        });
      }
    });

    const unsubscribeConnection = wsClient.subscribeConnection(setConnectionState);
    return () => {
      unsubscribe();
      unsubscribeConnection();
    };
  }, [wsClient, addPill, removePill, updateSession]);

  // Send message handler
  const sendMessage = useCallback(
    async (
      text: string,
      deliveryMode: DeliveryMode,
      images?: ImageAttachment[],
      targetSessionId?: string,
    ) => {
      try {
        await wsClient.sendMessage(text, deliveryMode, images, targetSessionId);
      } catch {
        await apiClient.sendMessage({
          text,
          source: "web",
          deliveryMode,
          images,
          targetSessionId,
        });
      }
    },
    [wsClient, apiClient, addPill],
  );

  const contextValue: PiSessionContextValue = {
    getSessionState: getSession,
    sendMessage,
    connectionState,
  };

  // Current path for active tab detection
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <PiSessionContext.Provider value={contextValue}>
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
    </PiSessionContext.Provider>
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
