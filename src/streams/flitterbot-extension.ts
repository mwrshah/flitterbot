import type { ExtensionFactory, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type FlitterbotTool = ToolDefinition;

export function createFlitterbotExtension(
  tools: FlitterbotTool[],
  skillPaths: string[],
): ExtensionFactory {
  return (pi) => {
    for (const tool of tools) pi.registerTool(tool);

    if (skillPaths.length > 0) {
      pi.on("resources_discover", () => ({ skillPaths }));
    }
  };
}
