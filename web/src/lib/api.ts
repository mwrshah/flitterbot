import type {
  DirectMessageResponse,
  DirectoryCompletionsResponse,
  StreamsHistoryResponse,
  SendMessageResponse,
  SessionDetailResponse,
  SessionListResponse,
  SkillsListResponse,
  StatusResponse,
  TranscriptPage,
} from "./types";

export type ControlSurfaceSettings = {
  baseUrl: string;
  token: string;
  useStubFallback: boolean;
};

export type AutonomaApiClient = ReturnType<typeof createAutonomaApiClient>;

export function createAutonomaApiClient(getSettings: () => ControlSurfaceSettings) {
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

    sendMessage: (body: {
      text: string;
      source: string;
      deliveryMode: string;
      images?: Array<{ data: string; mimeType: string }>;
      targetSessionId?: string;
    }) =>
      request<SendMessageResponse>("/message", {
        method: "POST",
        body: JSON.stringify(body),
      }),

    sendDirectSessionMessage: (sessionId: string, text: string) =>
      request<DirectMessageResponse>(`/sessions/${sessionId}/message`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),

    getStreamsHistory: (surface?: "input", streamsSessionId?: string) => {
      const params = new URLSearchParams();
      if (surface) params.set("surface", surface);
      if (streamsSessionId) params.set("streamsSessionId", streamsSessionId);
      const qs = params.toString();
      return request<StreamsHistoryResponse>(qs ? `/api/streams/history?${qs}` : "/api/streams/history");
    },

    startWhatsApp: () => request<{ ok: boolean }>("/runtime/whatsapp/start", { method: "POST" }),

    stopWhatsApp: () => request<{ ok: boolean }>("/runtime/whatsapp/stop", { method: "POST" }),

    interruptStreamsSession: (streamsSessionId: string) =>
      request<{ ok: boolean }>(`/api/stream-sessions/${streamsSessionId}/interrupt`, { method: "POST" }),

    reopenStream: (streamId: string) =>
      request<{ ok: boolean }>(`/api/streams/${streamId}/reopen`, { method: "POST" }),

    listSkills: () => request<SkillsListResponse>("/api/skills"),

    getDirectoryCompletions: (path: string, streamsSessionId?: string) => {
      const params = new URLSearchParams({ path });
      if (streamsSessionId) params.set("streamsSessionId", streamsSessionId);
      return request<DirectoryCompletionsResponse>(`/api/directory-completions?${params}`);
    },
  };
}
