import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings as SettingsIcon } from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";
import { Diff, type FileData, Hunk, type HunkData, parseDiff } from "react-diff-view";
import "react-diff-view/style/index.css";
import { cn } from "cn";
import { toast } from "sonner";
import { CopyableCode } from "@/components/common/copyable-code";
import { ShortcutHint } from "@/components/common/kbd";
import { DueTasksPanel } from "@/components/due-tasks-panel";
import { SettingsDrawer } from "@/components/settings-drawer";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useModifierLabel } from "@/hooks/platform";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import {
  DUE_TASKS_QUERY_KEY,
  streamsDiffQueryOptions,
  streamsDownstreamSessionsQueryOptions,
  streamsWorktreeQueryOptions,
} from "@/lib/queries";
import { useShortcutBindingLabel, useShortcuts } from "@/lib/shortcuts";
import type { DownstreamSessionItem, PiSessionStatus } from "@/lib/types";
import { getTmuxAttachShortcutActionId } from "../../../src/shortcuts/catalog.ts";

function piStatusBanner(
  status: PiSessionStatus | undefined,
): { label: string; colorClass: string } | null {
  switch (status) {
    case "active":
      return {
        label: "Inferring",
        colorClass: "bg-status-active-muted text-status-active",
      };
    case "waiting_for_sessions":
      return {
        label: "Supervising",
        colorClass: "bg-status-supervising-muted text-status-supervising",
      };
    case "waiting_for_user":
      return {
        label: "Idle",
        colorClass: "bg-status-waiting-muted text-status-waiting",
      };
    case "ended":
      return { label: "Ended", colorClass: "bg-status-ended-muted text-status-ended" };
    case "crashed":
      return {
        label: "Crashed",
        colorClass: "bg-status-crashed-muted text-status-crashed",
      };
    default:
      return null;
  }
}

function statusDotColor(status: DownstreamSessionItem["status"]): string {
  switch (status) {
    case "working":
      return "bg-status-active";
    case "idle":
      return "bg-status-idle";
    case "stale":
      return "bg-status-stale";
    case "ended":
      return "bg-status-ended";
  }
}

function sessionDescription(session: DownstreamSessionItem): string {
  return session.taskDescription ?? session.project ?? session.streamName ?? "no swimlane";
}

function CopyShortcutHint({ label, copied }: { label: string | undefined; copied: boolean }) {
  if (!label) {
    return copied ? <span className="text-text-muted text-[10px]">Copied!</span> : null;
  }

  return (
    <ShortcutHint label={label} variant="compact" actionText="Copied!" actionActive={copied} />
  );
}

function ActiveSessionTmuxCopy({
  tmuxSession,
  bindShortcut,
}: {
  tmuxSession: string;
  bindShortcut: boolean;
}) {
  const tmuxCopy = useCopyToClipboard(600);
  const command = `tmux attach -t ${tmuxSession}`;
  const copy = useCallback(() => {
    void tmuxCopy.copy(command).catch(() => toast.error("Failed to copy"));
  }, [command, tmuxCopy.copy]);
  const actionId = bindShortcut ? getTmuxAttachShortcutActionId(tmuxSession) : undefined;
  const shortcutLabel = useShortcutBindingLabel(actionId, { compact: true });
  useShortcuts("tmux", actionId ? { [actionId]: { run: copy } } : {});

  return (
    <>
      <CopyableCode text={command} copied={tmuxCopy.copied} onCopy={copy} />
      <CopyShortcutHint label={shortcutLabel} copied={tmuxCopy.copied} />
    </>
  );
}

export const DownstreamSessionsPanel = memo(function DownstreamSessionsPanel({
  piSessionId,
  piSessionStatus,
  showSettings = false,
  showDueTasks = false,
}: {
  piSessionId: string | undefined;
  piSessionStatus?: PiSessionStatus;
  showSettings?: boolean;
  showDueTasks?: boolean;
}) {
  useWhyDidYouRender("DownstreamSessionsPanel", {
    piSessionId,
    piSessionStatus,
    showSettings,
    showDueTasks,
  });
  const modifierLabel = useModifierLabel();
  const queryClient = useQueryClient();
  const [panelView, setPanelView] = useState<"info" | "diff">("info");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const statusBanner = piStatusBanner(piSessionStatus);

  const { data, isPending, isError } = useQuery(
    streamsDownstreamSessionsQueryOptions(piSessionId ?? "", !showDueTasks),
  );

  const shortcutOwningSessionIds = useMemo(() => {
    const owners = new Map<string, string>();
    for (const session of data ?? []) {
      if (session.tmuxSession && !owners.has(session.tmuxSession)) {
        owners.set(session.tmuxSession, session.sessionId);
      }
    }
    return new Set(owners.values());
  }, [data]);

  const worktreeQuery = useQuery(streamsWorktreeQueryOptions(piSessionId ?? ""));
  const worktree = worktreeQuery.data;
  const hasWorktree = !!worktree?.worktreePath;
  const showDiff = panelView === "diff";

  const diffQuery = useQuery(streamsDiffQueryOptions(piSessionId ?? "", showDiff && hasWorktree));

  const currentWorktreePath = worktree?.worktreePath ?? null;
  const currentRepoPath = worktree?.repoPath ?? null;
  const currentBranch = worktree?.branch ?? null;
  const targetBranch = worktree?.baseBranch ?? (hasWorktree ? "main" : null);
  const worktreeShortcutLabel = useShortcutBindingLabel("stream.copy-worktree-path", {
    compact: true,
  });
  const repoShortcutLabel = useShortcutBindingLabel("stream.copy-repo-path", { compact: true });
  const branchShortcutLabel = useShortcutBindingLabel("stream.copy-branch", { compact: true });
  const targetBranchShortcutLabel = useShortcutBindingLabel("stream.copy-target-branch", {
    compact: true,
  });
  const infoShortcutLabel = useShortcutBindingLabel("panel.view.info", {
    altLabel: modifierLabel,
  });
  const diffShortcutLabel = useShortcutBindingLabel("panel.view.diff", {
    altLabel: modifierLabel,
  });

  const worktreeCopy = useCopyToClipboard(600);
  const repoCopy = useCopyToClipboard(600);
  const branchCopy = useCopyToClipboard(600);
  const baseBranchCopy = useCopyToClipboard(600);

  const reloadDueTasks = useCallback(() => {
    if (!showDueTasks) return;
    void queryClient.refetchQueries({ queryKey: DUE_TASKS_QUERY_KEY, type: "active" });
  }, [queryClient, showDueTasks]);

  const showInfoPanel = useCallback(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    if (panelView === "info") reloadDueTasks();
    setPanelView("info");
  }, [panelView, reloadDueTasks]);

  const showDiffPanel = useCallback(() => {
    (document.activeElement as HTMLElement)?.blur?.();
    setPanelView("diff");
  }, []);

  const reloadDiff = useCallback(() => {
    if (diffQuery.isFetching) return;
    void diffQuery.refetch();
  }, [diffQuery.isFetching, diffQuery.refetch]);

  useShortcuts("stream", {
    "stream.copy-worktree-path": {
      enabled: Boolean(currentWorktreePath),
      run: () => {
        void worktreeCopy
          .copy(`${currentWorktreePath}/`)
          .catch(() => toast.error("Failed to copy"));
      },
    },
    "stream.copy-repo-path": {
      enabled: Boolean(currentRepoPath),
      run: () => {
        void repoCopy.copy(`${currentRepoPath}/`).catch(() => toast.error("Failed to copy"));
      },
    },
    "stream.copy-branch": {
      enabled: Boolean(currentBranch),
      run: () => {
        void branchCopy.copy(currentBranch!).catch(() => toast.error("Failed to copy"));
      },
    },
    "stream.copy-target-branch": {
      enabled: Boolean(targetBranch),
      run: () => {
        void baseBranchCopy.copy(targetBranch!).catch(() => toast.error("Failed to copy"));
      },
    },
    "panel.view.info": { run: showInfoPanel },
    "panel.view.diff": {
      enabled: hasWorktree,
      run: () => {
        if (showDiff) reloadDiff();
        showDiffPanel();
      },
    },
  });

  const diffFiles = useMemo<FileData[]>(() => {
    if (diffQuery.data?.mode !== "diff") return [];
    const files = parseDiff(diffQuery.data.diff);
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const change of hunk.changes) {
          const sign = change.type === "insert" ? "+" : change.type === "delete" ? "-" : " ";
          change.content = sign + change.content;
        }
      }
    }
    return files;
  }, [diffQuery.data]);

  if (!piSessionId) {
    return (
      <div className="flex flex-col h-full bg-background">
        <p className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-wider text-text-muted font-medium">
          Active Sessions
        </p>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-text-muted">Waiting for session…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="flex justify-between items-center gap-1 mx-3 mt-3 mb-2">
        {showSettings ? (
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex size-8 items-center justify-center rounded-lg text-text-muted outline-none hover:bg-background-hover hover:text-text focus-visible:ring-2 focus-visible:ring-border-pop"
            title="Settings"
            aria-label="Open settings"
          >
            <SettingsIcon className="size-4" aria-hidden="true" />
          </button>
        ) : statusBanner ? (
          <div
            className={cn("px-3 py-1.5 rounded-md text-xs font-medium", statusBanner.colorClass)}
          >
            {statusBanner.label}
          </div>
        ) : (
          <div />
        )}
        <ToggleGroup
          value={[panelView]}
          onValueChange={(newValue) => {
            const val = newValue[newValue.length - 1];
            if (val === "info" || val === "diff") {
              setPanelView(val);
            }
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem
            value="info"
            onClick={() => {
              if (panelView === "info") reloadDueTasks();
            }}
            className="text-sm aria-pressed:bg-background-selected aria-pressed:text-text"
          >
            Info
            {infoShortcutLabel && <ShortcutHint label={infoShortcutLabel} className="ml-1" />}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="diff"
            disabled={!hasWorktree}
            title={showDiff ? "Reload diff" : undefined}
            onClick={() => {
              if (showDiff) reloadDiff();
            }}
            className="group text-sm aria-pressed:bg-background-selected aria-pressed:text-text"
          >
            Diff
            {diffShortcutLabel && (
              <ShortcutHint
                label={diffShortcutLabel}
                actionText="RELOAD"
                actionOnHover={showDiff}
                actionKeycap
                className="ml-1"
              />
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <SettingsDrawer open={settingsOpen} onClose={closeSettings} />

      {showDiff && hasWorktree ? (
        <div className="relative flex-1 min-h-0">
          <div
            data-scroll-container="diff"
            className="h-full overflow-y-auto [scrollbar-gutter:auto] [scrollbar-width:thin]"
          >
            {diffQuery.isPending && (
              <p className="px-4 py-3 text-[11px] text-text-muted">Loading diff…</p>
            )}
            {diffQuery.isError && (
              <p className="px-4 py-3 text-xs text-status-crashed">Failed to load diff.</p>
            )}
            {diffQuery.isSuccess && !diffQuery.data && (
              <p className="px-4 py-3 text-xs text-text-muted">
                No changes against {worktree?.baseBranch ?? "main"}.
              </p>
            )}
            {diffQuery.isSuccess && diffQuery.data?.mode === "summary" && (
              <>
                <div className="mx-3 mt-2 mb-1 px-3 py-1.5 rounded-md text-xs font-medium bg-status-waiting-muted text-status-waiting">
                  Diff too large ({diffQuery.data.files} files,{" "}
                  {diffQuery.data.insertions.toLocaleString()}+ /{" "}
                  {diffQuery.data.deletions.toLocaleString()}&minus;), showing summary only
                </div>
                <pre className="px-4 py-2 text-xs text-text-muted whitespace-pre-wrap font-mono overflow-x-auto">
                  {diffQuery.data.stat}
                </pre>
              </>
            )}
            {diffQuery.isSuccess && diffQuery.data?.mode === "diff" && (
              <div className="diff-viewer-panel text-xs">
                {diffFiles.map((file) => {
                  const path = file.newPath || file.oldPath || "(unknown)";
                  const key = `${file.oldRevision}-${file.newRevision}-${path}`;
                  return (
                    <div key={key} className="mb-3 last:mb-0">
                      <div className="sticky top-0 z-10 px-3 py-1 text-[11px] font-mono text-text-muted border-b border-border bg-background truncate">
                        {path}
                      </div>
                      <Diff viewType="unified" diffType={file.type} hunks={file.hunks}>
                        {(hunks: HunkData[]) =>
                          hunks.map((hunk: HunkData) => (
                            <Hunk
                              key={`${hunk.oldStart},${hunk.oldLines} ${hunk.newStart},${hunk.newLines}`}
                              hunk={hunk}
                            />
                          ))
                        }
                      </Diff>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : showDueTasks ? (
        <DueTasksPanel />
      ) : (
        <div className="flex-1 overflow-y-auto [scrollbar-gutter:auto] [scrollbar-width:thin]">
          <p className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-wider text-text-muted font-medium">
            Active Sessions
          </p>
          {isPending && <p className="px-4 py-3 text-xs text-text-muted">Loading sessions…</p>}
          {isError && (
            <p className="px-4 py-3 text-xs text-status-crashed">Failed to load sessions.</p>
          )}
          {data && data.length === 0 && (
            <p className="px-4 py-3 text-xs text-text-muted">No active sessions</p>
          )}
          {data && data.length > 0 && (
            <ul className="divide-y divide-border">
              {data.map((session) => (
                <li key={session.sessionId} className="flex flex-col gap-1 px-4 py-2.5">
                  <div className="flex items-center gap-2 min-w-0">
                    <span
                      className={cn(
                        "shrink-0 h-2 w-2 rounded-full",
                        statusDotColor(session.status),
                      )}
                      aria-hidden
                    />
                    <span className="truncate font-mono text-xs text-text">
                      {session.sessionId.slice(0, 8)}
                    </span>
                    <span className="text-[10px] text-text-muted">{session.status}</span>
                  </div>

                  {session.tmuxSession && (
                    <span className="pl-2 text-xs text-text-muted flex items-center gap-1 min-w-0">
                      tmux:{" "}
                      <ActiveSessionTmuxCopy
                        tmuxSession={session.tmuxSession}
                        bindShortcut={shortcutOwningSessionIds.has(session.sessionId)}
                      />
                    </span>
                  )}

                  <span className="pl-2 text-xs text-text-muted truncate">
                    cwd: {sessionDescription(session)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {worktree?.worktreePath && (
            <div className="px-4 py-3 border-t-2 border-border-muted">
              <p className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-2">
                Active Worktree
              </p>
              <div className="flex flex-col gap-0.5 py-1.5">
                <span className="pl-2 truncate text-xs text-text-muted flex items-center gap-1 min-w-0">
                  Repo:{" "}
                  {currentRepoPath && (
                    <CopyableCode
                      text={currentRepoPath}
                      displayText={worktree.repo ?? currentRepoPath}
                      copied={repoCopy.copied}
                      onCopy={() => repoCopy.copy(`${currentRepoPath}/`)}
                    />
                  )}
                  <CopyShortcutHint label={repoShortcutLabel} copied={repoCopy.copied} />
                </span>
                <span className="pl-2 truncate text-xs text-text-muted flex items-center gap-1 min-w-0">
                  Branch:{" "}
                  <CopyableCode
                    text={currentBranch ?? ""}
                    copied={branchCopy.copied}
                    onCopy={() => currentBranch && branchCopy.copy(currentBranch)}
                  />
                  <CopyShortcutHint label={branchShortcutLabel} copied={branchCopy.copied} />
                </span>
                <span className="pl-2 text-xs text-text-muted flex items-center gap-1 min-w-0">
                  Merge Target:{" "}
                  <CopyableCode
                    text={targetBranch ?? ""}
                    copied={baseBranchCopy.copied}
                    onCopy={() => targetBranch && baseBranchCopy.copy(targetBranch)}
                  />
                  <CopyShortcutHint
                    label={targetBranchShortcutLabel}
                    copied={baseBranchCopy.copied}
                  />
                </span>
                <span className="pl-2 text-xs text-text-muted flex items-center gap-1 min-w-0">
                  Worktree:{" "}
                  <CopyableCode
                    text={worktree.worktreePath ?? ""}
                    displayText={(() => {
                      const parts = (worktree.worktreePath ?? "").split("/");
                      const leaf = parts[parts.length - 1] ?? "";
                      return `../${leaf}`;
                    })()}
                    copied={worktreeCopy.copied}
                    onCopy={() =>
                      currentWorktreePath && worktreeCopy.copy(`${currentWorktreePath}/`)
                    }
                  />
                  <CopyShortcutHint label={worktreeShortcutLabel} copied={worktreeCopy.copied} />
                </span>
              </div>
            </div>
          )}

          {((worktree?.copyPaths?.length ?? 0) > 0 ||
            (worktree?.postCreate?.length ?? 0) > 0 ||
            !!worktree?.configuredBaseRef) && (
            <div className="px-4 py-3 border-t-2 border-border-muted">
              <p className="text-[10px] uppercase tracking-wider text-text-muted font-medium mb-1">
                Bootstrap Config
              </p>
              {worktree?.configuredBaseRef && (
                <div className="pl-2 py-0.5">
                  <span className="text-[10px] text-text-muted">baseRef</span>
                  <p className="mt-0.5 text-xs text-text-muted font-mono truncate">
                    {worktree.configuredBaseRef}
                  </p>
                </div>
              )}
              {(worktree?.copyPaths?.length ?? 0) > 0 && (
                <div className="pl-2 py-0.5">
                  <span className="text-[10px] text-text-muted">copyPaths</span>
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {worktree?.copyPaths?.map((p) => (
                      <li key={p} className="text-xs text-text-muted font-mono truncate" title={p}>
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(worktree?.postCreate?.length ?? 0) > 0 && (
                <div className="pl-2 py-0.5">
                  <span className="text-[10px] text-text-muted">postCreate</span>
                  <ul className="mt-0.5 flex flex-col gap-0.5">
                    {worktree?.postCreate?.map((c) => (
                      <li key={c} className="text-xs text-text-muted font-mono truncate" title={c}>
                        {c}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
