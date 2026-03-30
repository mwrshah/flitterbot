import { useMemo } from "react";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { timelineToAgentMessages } from "~/lib/pi-web-ui-bridge";
import type { ChatTimelineItem } from "~/lib/types";

/** Converts timeline items to AgentMessages, recomputing only when the timeline reference changes. */
export function useAgentMessages(timeline: ChatTimelineItem[]): AgentMessage[] {
  return useMemo(() => timelineToAgentMessages(timeline), [timeline]);
}
