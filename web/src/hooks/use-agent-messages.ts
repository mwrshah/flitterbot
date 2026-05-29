import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { useMemo } from "react";
import { timelineToAgentMessages } from "~/lib/pi-web-ui-bridge";
import type { ChatTimelineItem } from "~/lib/types";

export function useAgentMessages(timeline: ChatTimelineItem[]): AgentMessage[] {
  return useMemo(() => timelineToAgentMessages(timeline), [timeline]);
}
