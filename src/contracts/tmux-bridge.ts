export type TmuxUiState = "IDLE" | "INFERRING" | "NO_AGENT" | "BUSY_OTHER" | "MISSING";
export type TmuxDeliveryMethod = "tmux_send_keys";

export interface TmuxSessionSummary {
  sessionName: string;
  windowCount: number;
  attached: boolean;
  createdAtEpochSeconds: number;
}

export interface TmuxPaneSnapshot {
  target: string;
  paneId: string;
  panePid: number | null;
  currentCommand: string | null;
  capture: string;
  uiState: TmuxUiState;
}

export interface TmuxSessionInspection extends TmuxSessionSummary {
  exists: boolean;
  pane: TmuxPaneSnapshot | null;
}

export interface LaunchAgentSessionInput {
  cwd: string;
  prompt: string;
  sessionName?: string;
  taskDescription?: string;
  todoistTaskId?: string;
  piSessionId?: string;
  streamId?: string;
  agentCommand?: string;
  extraArgs?: string[];
}

export interface LaunchAgentSessionResult {
  tmuxSession: string;
  cwd: string;
  delivery: TmuxDeliveryMethod;
}

export type SendMessageToTmuxSessionFailureReason =
  | "tmux_session_missing"
  | "no_live_agent"
  | "message_not_acknowledged";

export type SendMessageToTmuxSessionResult =
  | {
      ok: true;
      delivery: TmuxDeliveryMethod;
      retries: number;
      uiState: TmuxUiState;
    }
  | {
      ok: false;
      reason: SendMessageToTmuxSessionFailureReason;
      retries?: number;
      uiState: TmuxUiState;
    };
