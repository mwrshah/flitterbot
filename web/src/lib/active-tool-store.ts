export type ActiveToolState = {
  toolUseId: string;
  pending: boolean;
  partialResult?: unknown;
  isError?: boolean;
};

export type ActiveToolStoreEvent =
  | { type: "upsert"; state: ActiveToolState }
  | { type: "clear_all" };

type ActiveToolCallback = (event: ActiveToolStoreEvent) => void;

const activeToolsBySession = new Map<string, Map<string, ActiveToolState>>();
const callbacksBySession = new Map<string, ActiveToolCallback>();

function getSessionTools(sessionId: string): Map<string, ActiveToolState> {
  let tools = activeToolsBySession.get(sessionId);
  if (!tools) {
    tools = new Map<string, ActiveToolState>();
    activeToolsBySession.set(sessionId, tools);
  }
  return tools;
}

function emit(sessionId: string, event: ActiveToolStoreEvent): void {
  const callback = callbacksBySession.get(sessionId);
  if (callback) callback(event);
}

export const activeToolStore = {
  getSnapshot(sessionId: string): ActiveToolState[] {
    const tools = activeToolsBySession.get(sessionId);
    return tools ? Array.from(tools.values()).map((state) => ({ ...state })) : [];
  },

  upsertTool(
    sessionId: string,
    next: Pick<ActiveToolState, "toolUseId"> &
      Partial<Omit<ActiveToolState, "toolUseId">> & { pending?: boolean },
  ): void {
    const tools = getSessionTools(sessionId);
    const prev = tools.get(next.toolUseId);
    const merged: ActiveToolState = {
      toolUseId: next.toolUseId,
      pending: next.pending ?? prev?.pending ?? true,
      partialResult: next.partialResult !== undefined ? next.partialResult : prev?.partialResult,
      isError: next.isError ?? prev?.isError,
    };
    tools.set(next.toolUseId, merged);
    emit(sessionId, { type: "upsert", state: { ...merged } });
  },

  dropTool(sessionId: string, toolUseId: string): void {
    const tools = activeToolsBySession.get(sessionId);
    if (!tools) return;
    tools.delete(toolUseId);
    if (tools.size === 0) {
      activeToolsBySession.delete(sessionId);
    }
  },

  clearSession(sessionId: string): void {
    if (!activeToolsBySession.has(sessionId)) return;
    activeToolsBySession.delete(sessionId);
    emit(sessionId, { type: "clear_all" });
  },

  onUpdate(sessionId: string, callback: ActiveToolCallback): void {
    callbacksBySession.set(sessionId, callback);
  },

  offUpdate(sessionId: string): void {
    callbacksBySession.delete(sessionId);
  },
};
