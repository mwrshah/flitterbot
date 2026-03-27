/**
 * Stable memoization of timelineToAgentMessages.
 *
 * The timeline array reference changes on every WS event (setQueryData
 * creates a new array). Fingerprints by length + last-item id so the
 * conversion only reruns when the timeline actually grows or changes.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { timelineToAgentMessages } from "~/lib/pi-web-ui-bridge";
import type { ChatTimelineItem } from "~/lib/types";
import { timelineFingerprint } from "~/lib/utils";
import { useStableMemo } from "./use-stable-memo";

export function useAgentMessages(timeline: ChatTimelineItem[]): AgentMessage[] {
  return useStableMemo(timelineFingerprint(timeline), () => timelineToAgentMessages(timeline));
}
