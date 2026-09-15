import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { StreamRow } from "../contracts/index.ts";
import { git } from "../git.ts";
import { readWorktreeConfig } from "../streams/worktree-config.ts";
import type { CloudClient } from "./client.ts";
import type { WorkerBootstrap } from "./worker-agent.ts";

const result = (details: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(details) }],
  details,
});

export function createCloudTools(
  client: CloudClient,
  bootstrap: WorkerBootstrap,
  publish: () => Promise<void>,
  settleDownstream: () => Promise<void>,
  currentUserEntry: () => string | undefined,
): ToolDefinition[] {
  let preview: { base: string | null; userEntry: string | undefined } | undefined;
  async function configureControllerRemote(root: string, stream: StreamRow): Promise<void> {
    if (!stream.repo_path) return;
    if (!bootstrap.controllerVm) throw new Error("Controller VM identity is missing");
    const url = `${bootstrap.controllerVm}.exe.xyz:${stream.repo_path}`;
    const exists = (await git(root, ["remote"])).split("\n").includes("flitterbot-main");
    await git(root, ["remote", exists ? "set-url" : "add", "flitterbot-main", url]);
    await git(root, [
      "config",
      "remote.flitterbot-main.pushurl",
      "disabled://controller-push-disabled",
    ]);
  }
  return [
    {
      name: "set_up_worktree",
      label: "Prepare isolated workspace",
      description:
        "Inspect or prepare this stream's VM-isolated Git workspace. The VM already contains its own filesystem and environment, so apply creates a stream branch in place and preserves inherited dirty files. No linked worktree is needed. base_ref records the merge target; it does not reset the existing workspace. Starting state belongs to stream creation.",
      parameters: {
        type: "object",
        required: ["mode"],
        properties: {
          mode: { type: "string", enum: ["inspect", "apply"] },
          base_ref: { type: "string" },
        },
        additionalProperties: false,
      },
      async execute(_id: string, params: Record<string, unknown>) {
        const root = (await git(bootstrap.cwd, ["rev-parse", "--show-toplevel"])).trim();
        const stream = await client.request<StreamRow>("stream");
        const config = await readWorktreeConfig(root);
        let branch = (await git(root, ["branch", "--show-current"])).trim();
        const base =
          typeof params.base_ref === "string"
            ? params.base_ref
            : (stream.base_branch ?? config.baseRef ?? branch);
        if (!base) throw new Error("Choose a named merge target for this detached checkout");
        await git(root, ["check-ref-format", "--branch", base]);
        const ref = (
          await git(root, ["rev-parse", "--symbolic-full-name", "--verify", base])
        ).trim();
        if (!/^refs\/(heads|remotes)\//.test(ref)) throw new Error("base_ref must name a branch");
        if (params.mode === "apply") {
          const desired = `cloud/${bootstrap.streamId}`;
          if (branch !== desired) {
            let exists = false;
            try {
              await git(root, ["show-ref", "--verify", `refs/heads/${desired}`]);
              exists = true;
            } catch {}
            await git(root, exists ? ["switch", desired] : ["switch", "-c", desired]);
            branch = desired;
          }
          await configureControllerRemote(root, stream);
          await client.request("workspace", { baseBranch: base.replace(/^origin\//, "") });
        }
        return result({
          ok: true,
          streamId: bootstrap.streamId,
          worktreePath: root,
          branchName: branch,
          baseBranch: base,
          vmIsolated: true,
          configuration: config,
        });
      },
    },
    {
      name: "close_swimlane",
      label: "Close cloud stream",
      description:
        "Close only after the user signals finality. For merge, first omit base_branch to obtain a non-destructive preview; relay it to the user and wait for confirmation. With an explicitly confirmed base_branch, commit stream changes using the supplied descriptive commit_message, publish them, and merge into the clean controller checkout. Never pushes. Conflicts leave the VM and stream open. noop skips Git merge. Successful close publishes the final native session before removing this VM.",
      parameters: {
        type: "object",
        required: ["mode", "commit_message"],
        properties: {
          mode: { type: "string", enum: ["merge", "noop"] },
          commit_message: { type: "string" },
          base_branch: {
            type: ["string", "null"],
            description:
              "Null for preview. Supply the named branch only after a new user confirmation.",
          },
        },
        additionalProperties: false,
      },
      async execute(_id: string, params: Record<string, unknown>) {
        if (params.mode !== "merge" && params.mode !== "noop")
          throw new Error("Invalid close mode");
        if (params.mode === "noop" && preview && preview.userEntry === currentUserEntry())
          throw new Error("A merge preview requires a new user response before closing");
        if (params.mode === "merge") {
          const stream = await client.request<StreamRow>("stream");
          const root = (await git(bootstrap.cwd, ["rev-parse", "--show-toplevel"])).trim();
          const base = typeof params.base_branch === "string" ? params.base_branch.trim() : "";
          const userEntry = currentUserEntry();
          if (!base || !preview || preview.base !== base || preview.userEntry === userEntry) {
            preview = {
              base: base || stream.base_branch || (await readWorktreeConfig(root)).baseRef || null,
              userEntry,
            };
            return result({
              ok: true,
              needsConfirmation: true,
              currentBranch: (await git(root, ["branch", "--show-current"])).trim(),
              resolvedBaseBranch: preview.base,
              message:
                "Ask the user to confirm. Execution requires a new user message after this preview.",
            });
          }
          await git(root, ["check-ref-format", "--branch", base]);
          if (typeof params.commit_message !== "string" || !params.commit_message.trim())
            throw new Error("Descriptive commit_message required");
          await configureControllerRemote(root, stream);
          await settleDownstream();
          if ((await git(root, ["status", "--porcelain"])).trim()) {
            await git(root, ["add", "--all"]);
            await git(root, ["commit", "-m", params.commit_message]);
          }
          await publish();
          const merged = await client.request<{
            ok: boolean;
            message?: string;
            conflicts?: string[];
          }>("merge", { baseBranch: base });
          if (!merged.ok)
            return result({
              ...merged,
              next: `Fetch ${params.base_branch} from flitterbot-main and merge it here. Resolve conflicts without discarding work, then retry. Main remains unchanged.`,
            });
        }
        await client.request("close", {});
        return result({
          ok: true,
          closing: true,
          message:
            "Finish your reply. Main waits for settlement and the final checkpoint before removing this VM. No push occurs.",
        });
      },
    },
  ];
}
