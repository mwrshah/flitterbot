/**
 * Stable memoization of timelineToAgentMessages.
 *
 * The timeline array reference changes on every WS event (setQueryData
 * creates a new array). This hook fingerprints the timeline by length
 * and last-item id, only recomputing the AgentMessage[] conversion when
 * the timeline actually grows or changes — not on every new reference.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { useRef } from "react";
import { timelineToAgentMessages } from "~/lib/pi-web-ui-bridge";
import type { ChatTimelineItem } from "~/lib/types";

function timelineFingerprint(timeline: ChatTimelineItem[]): string {
  if (!timeline.length) return "0:";
  const last = timeline[timeline.length - 1]!;
  return `${timeline.length}:${last.id}`;
}

export function useAgentMessages(timeline: ChatTimelineItem[]): AgentMessage[] {
  const prevFpRef = useRef("");
  const prevResultRef = useRef<AgentMessage[]>([]);

  const fp = timelineFingerprint(timeline);
  if (fp !== prevFpRef.current) {
    prevFpRef.current = fp;
    prevResultRef.current = timelineToAgentMessages(timeline);
  }

  return prevResultRef.current;
}
