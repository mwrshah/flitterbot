import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type FlitterbotTool = ToolDefinition;

export function createFlitterbotExtension(tools: FlitterbotTool[]): ExtensionFactory {
  return (pi) => {
    for (const tool of tools) pi.registerTool(tool);
  };
}
