import type { BlackboardDatabase } from "../blackboard/db.ts";
import { markSessionEnded } from "../blackboard/query-sessions.ts";
import { killTmuxSession } from "../tmux-sessions/tmux.ts";

type ActiveDownstreamSession = {
  session_id: string;
  tmux_session: string | null;
};

export async function terminateDownstreamSessions(
  blackboard: BlackboardDatabase,
  streamId: string,
): Promise<number> {
  let terminated = 0;
  for (;;) {
    const sessions = blackboard
      .prepare(
        `SELECT session_id, tmux_session
         FROM sessions
         WHERE stream_id = ?
           AND status IN ('working', 'idle')`,
      )
      .all(streamId) as ActiveDownstreamSession[];
    if (sessions.length === 0) return terminated;

    for (const session of sessions) {
      if (session.tmux_session) await killTmuxSession(session.tmux_session);
      markSessionEnded(blackboard, session.session_id, "stream_closed");
      terminated++;
    }
  }
}
