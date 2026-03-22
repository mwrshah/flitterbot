import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useControlSurface } from "~/hooks/use-control-surface";
import { ChatPanel } from "~/components/chat/ChatPanel";
import { Badge } from "~/components/ui/Badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "~/components/ui/Tabs";

export const Route = createFileRoute("/pi")({
  head: () => ({
    meta: [{ title: "Autonoma — Pi Agent" }],
  }),
  component: PiAgentPage,
});

function PiAgentPage() {
  const { apiClient } = useControlSurface();
  const [activeSessionId, setActiveSessionId] = useState("default");

  const statusQuery = useQuery({
    queryKey: ["status"],
    queryFn: () => apiClient.getStatus(),
    refetchInterval: 5_000,
    retry: 1,
  });

  const orchestrators = statusQuery.data?.pi?.orchestrators ?? [];
  const defaultPi = statusQuery.data?.pi?.default;
  const hasTabs = orchestrators.length > 0;

  if (!hasTabs) {
    return <ChatPanel />;
  }

  return (
    <Tabs value={activeSessionId} onValueChange={setActiveSessionId} className="h-full">
      <TabsList>
        <TabsTrigger value="default">
          Default
          {defaultPi?.busy && <Badge variant="success">active</Badge>}
        </TabsTrigger>
        {orchestrators.map((o) => (
          <TabsTrigger key={o.sessionId} value={o.sessionId}>
            {o.workstreamName ?? o.workstreamId}
            {o.busy && <Badge variant="success">active</Badge>}
          </TabsTrigger>
        ))}
      </TabsList>

      <TabsContent value="default">
        <ChatPanel key="default" />
      </TabsContent>
      {orchestrators.map((o) => (
        <TabsContent key={o.sessionId} value={o.sessionId}>
          <ChatPanel key={o.sessionId} piSessionId={o.sessionId} />
        </TabsContent>
      ))}
    </Tabs>
  );
}
