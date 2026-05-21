import type {
  DirectMessageResponse,
  DirectoryCompletionsResponse,
  ModelsListResponse,
  ModelsMutationResponse,
  SessionDetailResponse,
  SessionListResponse,
  SkillsListResponse,
  StatusResponse,
  StreamsHistoryResponse,
  ThinkingLevel,
  TranscriptPage,
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

    listSessions: () => request<SessionListResponse>("/api/sessions"),

    getSessionDetail: (sessionId: string) =>
      request<SessionDetailResponse>(`/api/sessions/${sessionId}`),

    getTranscript: (sessionId: string, cursor?: string, limit = 25) => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (cursor) params.set("cursor", cursor);
      return request<TranscriptPage>(`/api/sessions/${sessionId}/transcript?${params}`);
    },

    sendDirectSessionMessage: (sessionId: string, text: string) =>
      request<DirectMessageResponse>(`/sessions/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),

    getStreamsHistory: (surface?: "input", piSessionId?: string) => {
      const params = new URLSearchParams();
      if (surface) params.set("surface", surface);
      if (piSessionId) params.set("piSessionId", piSessionId);
      const qs = params.toString();
      return request<StreamsHistoryResponse>(
        qs ? `/api/streams/history?${qs}` : "/api/streams/history",
      );
    },

    startWhatsApp: () => request<{ ok: boolean }>("/runtime/whatsapp/start", { method: "POST" }),

    stopWhatsApp: () => request<{ ok: boolean }>("/runtime/whatsapp/stop", { method: "POST" }),

    interruptPiSession: (piSessionId: string) =>
      request<{ ok: boolean }>(`/api/pi-sessions/${piSessionId}/interrupt`, {
        method: "POST",
      }),

    reopenStream: (streamId: string) =>
      request<{ ok: boolean }>(`/api/streams/${streamId}/reopen`, { method: "POST" }),

    createStream: (body?: { name?: string; cwd?: string }) =>
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

    setPiSessionThinkingLevel: (piSessionId: string, level: ThinkingLevel) =>
      request<ModelsMutationResponse>(`/api/pi-sessions/${piSessionId}/thinking-level`, {
        method: "PUT",
        body: JSON.stringify({ level }),
      }),

    getDirectoryCompletions: (path: string, piSessionId?: string) => {
      const params = new URLSearchParams({ path });
      if (piSessionId) params.set("piSessionId", piSessionId);
      return request<DirectoryCompletionsResponse>(`/api/directory-completions?${params}`);
    },

    getUserConfig: (userId: string) =>
      request<{ config: Record<string, string> }>(`/api/user-config/${userId}`),

    setUserConfig: (userId: string, config: Record<string, string>) =>
      request<{ ok: boolean }>(`/api/user-config/${userId}`, {
        method: "PUT",
        body: JSON.stringify({ config }),
      }),
  };
}
