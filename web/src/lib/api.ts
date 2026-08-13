import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
  AuthFlowSnapshot,
  AuthProvidersResponse,
  DirectoryCompletionsResponse,
  DirectSessionMessageResponse,
  ModelsListResponse,
  ModelsMutationResponse,
  SessionDetailResponse,
  SessionSearchResponse,
  SessionsListResponse,
  SkillsListResponse,
  StatusResponse,
  TranscriptPageResponse,
} from "./types";

export type ControlSurfaceSettings = {
  baseUrl: string;
  token: string;
  useStubFallback: boolean;
};

export type FlitterbotApiClient = ReturnType<typeof createFlitterbotApiClient>;

export function createFlitterbotApiClient(getSettings: () => ControlSurfaceSettings) {
  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const { baseUrl, token } = getSettings();
    const url = `${baseUrl.replace(/\/$/, "")}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers as Record<string, string> | undefined),
    };

    const response = await fetch(url, { ...init, headers });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  return {
    getStatus: () => request<StatusResponse>("/status"),

    listSessions: () => request<SessionsListResponse>("/api/sessions"),

    getSessionDetail: (sessionId: string) =>
      request<SessionDetailResponse>(`/api/sessions/${sessionId}`),

    searchSessions: (query: string) =>
      request<SessionSearchResponse>(`/api/session-search?${new URLSearchParams({ query })}`),

    getTranscript: (sessionId: string, cursor?: string, limit = 25) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      return request<TranscriptPageResponse>(`/api/sessions/${sessionId}/transcript?${params}`);
    },

    sendDirectSessionMessage: (sessionId: string, text: string) =>
      request<DirectSessionMessageResponse>(`/sessions/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),

    startWhatsApp: () => request<{ ok: boolean }>("/runtime/whatsapp/start", { method: "POST" }),

    stopWhatsApp: () => request<{ ok: boolean }>("/runtime/whatsapp/stop", { method: "POST" }),

    interruptPiSession: (piSessionId: string) =>
      request<{ ok: boolean }>(`/api/pi-sessions/${piSessionId}/interrupt`, {
        method: "POST",
      }),

    reopenStream: (streamId: string) =>
      request<{ ok: boolean }>(`/api/streams/${streamId}/reopen`, { method: "POST" }),

    closeSwimlane: (streamId: string) =>
      request<{ ok: true; streamId: string; message: string }>(`/api/streams/${streamId}/close`, {
        method: "POST",
      }),

    setStreamPinned: (streamId: string, pinned: boolean) =>
      request<{ ok: true; streamId: string; pinned: boolean }>(`/api/streams/${streamId}/pin`, {
        method: "PUT",
        body: JSON.stringify({ pinned }),
      }),

    setStreamName: (streamId: string, name: string) =>
      request<{ ok: true; streamId: string; name: string }>(`/api/streams/${streamId}/name`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      }),

    createSwimlane: (body?: { name?: string; cwd?: string }) =>
      request<{ ok: true; streamId: string; streamName: string; piSessionId: string }>(
        "/api/streams",
        {
          method: "POST",
          body: JSON.stringify(body ?? {}),
        },
      ),

    pruneStreamHistory: (piSessionId: string, entryId: string) =>
      request<{ ok: true; piSessionId: string; messageCount: number }>("/api/streams/prune", {
        method: "POST",
        body: JSON.stringify({ piSessionId, entryId }),
      }),

    forkStream: (piSessionId: string, entryId?: string) =>
      request<{ ok: true; streamId: string; streamName: string; piSessionId: string }>(
        "/api/streams/fork",
        {
          method: "POST",
          body: JSON.stringify({ piSessionId, ...(entryId ? { entryId } : {}) }),
        },
      ),

    compactPiSession: (piSessionId: string, customInstructions?: string) =>
      request<{
        ok: true;
        piSessionId: string;
        messageCount: number;
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
      }>("/api/streams/compact", {
        method: "POST",
        body: JSON.stringify({ piSessionId, customInstructions }),
      }),

    listSkills: () => request<SkillsListResponse>("/api/skills"),

    listModels: () => request<ModelsListResponse>("/api/models"),

    pinModel: (id: string, pin: boolean, label?: string) =>
      request<ModelsMutationResponse>("/api/models/pin", {
        method: "POST",
        body: JSON.stringify({ id, pin, ...(label ? { label } : {}) }),
      }),

    setPiSessionModel: (piSessionId: string, id: string) =>
      request<ModelsMutationResponse>(`/api/pi-sessions/${piSessionId}/model`, {
        method: "PUT",
        body: JSON.stringify({ id }),
      }),

    setPiSessionThinkingLevel: (piSessionId: string, level: ModelThinkingLevel) =>
      request<ModelsMutationResponse>(`/api/pi-sessions/${piSessionId}/thinking-level`, {
        method: "PUT",
        body: JSON.stringify({ level }),
      }),

    getDirectoryCompletions: (path: string, piSessionId?: string) => {
      const params = new URLSearchParams({ path });
      if (piSessionId) params.set("piSessionId", piSessionId);
      return request<DirectoryCompletionsResponse>(`/api/directory-completions?${params}`);
    },

    listAuthProviders: () => request<AuthProvidersResponse>("/api/auth/providers"),

    startAuthLogin: (providerId: string) =>
      request<AuthFlowSnapshot>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ providerId }),
      }),

    getAuthFlow: (flowId: string) =>
      request<AuthFlowSnapshot>(`/api/auth/flows/${encodeURIComponent(flowId)}`),

    respondAuthFlow: (flowId: string, promptId: string, value: string) =>
      request<AuthFlowSnapshot>(`/api/auth/flows/${encodeURIComponent(flowId)}/respond`, {
        method: "POST",
        body: JSON.stringify({ promptId, value }),
      }),

    cancelAuthFlow: (flowId: string) =>
      request<AuthFlowSnapshot>(`/api/auth/flows/${encodeURIComponent(flowId)}`, {
        method: "DELETE",
      }),

    logoutAuthProvider: (providerId: string) =>
      request<{ ok: true }>(`/api/auth/providers/${encodeURIComponent(providerId)}`, {
        method: "DELETE",
      }),

    getUserConfig: (userId: string) =>
      request<{ config: Record<string, string> }>(`/api/user-config/${userId}`),

    setUserConfig: (userId: string, config: Record<string, string>) =>
      request<{ ok: boolean }>(`/api/user-config/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ config }),
      }),
  };
}
