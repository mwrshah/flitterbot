import { useQuery } from "@tanstack/react-query";
import { html as diff2html } from "diff2html";
import { ColorSchemeType } from "diff2html/lib/types";
import "diff2html/bundles/css/diff2html.min.css";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ToggleGroup, ToggleGroupItem } from "~/components/ui/toggle-group";
import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";
import { useTheme } from "~/hooks/use-theme";
import { useWhyDidYouRender } from "~/hooks/use-why-did-you-render";
import {
  registerShortcutHandlers,
  SHORTCUT_ACTIONS,
  setActiveScrollContainer,
  useShortcutBindingLabel,
} from "~/lib/global-shortcuts";
import {
  streamsDiffQueryOptions,
  streamsDownstreamSessionsQueryOptions,
  streamsWorktreeQueryOptions,
} from "~/lib/queries";
import type { DownstreamSessionItem, PiSessionStatus } from "~/lib/types";
import { cn } from "~/lib/utils";

function piStatusBanner(status: PiSessionStatus | undefined) {
  switch (status) {
    case "active":
      return {
        label: "Inferring",
        colorClass: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      };
    case "waiting_for_sessions":
      return {
        label: "Waiting for sessions",
        colorClass: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
      };
    case "waiting_for_user":
      return {
        label: "Waiting for user",
        colorClass: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
      };
    case "ended":
      return { label: "Ended", colorClass: "bg-zinc-500/15 text-zinc-500" };
    case "crashed":
      return { label: "Crashed", colorClass: "bg-red-500/15 text-red-600 dark:text-red-400" };
    default:
      return null;
  }
}

function CopyableCode({
  text,
  displayText,
  copied: externalCopied,
  onCopy,
}: {
  text: string;
  displayText?: string;
  copied?: boolean;
  onCopy?: () => void;
}) {
  const internal = useCopyToClipboard(600);
  const isControlled = onCopy !== undefined;
  const isCopied = isControlled ? (externalCopied ?? false) : internal.copied;

  return (
    <button
      type="button"
      onClick={() => (isControlled ? onCopy() : internal.copy(text))}
      className="inline-block font-mono text-xs bg-muted/60 hover:bg-muted rounded px-1.5 py-0.5 cursor-pointer truncate max-w-full text-left transition-colors"
      title={`copy \`${text}\``}
    >
      {!isControlled && isCopied ? (
        <span className="text-muted-foreground">Copied!</span>
      ) : (
        <span>{displayText ?? text}</span>
      )}
    </button>
  );
}

function statusDotColor(status: DownstreamSessionItem["status"]): string {
  switch (status) {
    case "working":
      return "bg-emerald-500";
    case "idle":
      return "bg-blue-400";
    case "stale":
      return "bg-amber-500";
    case "ended":
      return "bg-zinc-500";
  }
}

function statusLabel(status: DownstreamSessionItem["status"]): string {
  switch (status) {
    case "working":
      return "working";
    case "idle":
      return "idle";
    case "stale":
      return "stale";
    case "ended":
      return "ended";
  }
}

function sessionDescription(session: DownstreamSessionItem): string {
  return session.taskDescription ?? session.project ?? session.streamName ?? "no stream";
}

export function DownstreamSessionsPanel({
  piSessionId,
  piSessionStatus,
}: {
  piSessionId: string | undefined;
  piSessionStatus?: PiSessionStatus;
}) {
  useWhyDidYouRender("DownstreamSessionsPanel", { piSessionId, piSessionStatus });
  const { resolvedTheme } = useTheme();
  const [panelView, setPanelView] = useState<"info" | "diff">("info");
  useEffect(() => {
    setPanelView("info");
    setActiveScrollContainer("main");
  }, [piSessionId]);
  const { data, isPending, isError } = useQuery(
    streamsDownstreamSessionsQueryOptions(piSessionId ?? ""),
  );

  const worktreeQuery = useQuery(streamsWorktreeQueryOptions(piSessionId ?? ""));
  const worktree = worktreeQuery.data;
  const hasWorktree = !!worktree?.worktreePath;
  const showDiff = panelView === "diff";

  const diffQuery = useQuery(streamsDiffQueryOptions(piSessionId ?? "", showDiff && hasWorktree));

  // Register stream copy handlers with higher priority than the root fallback.
  const ctTargetSessionId = data?.find((s) => s.tmuxSession)?.sessionId ?? null;
  const firstTmuxSession = data?.find((s) => s.tmuxSession)?.tmuxSession ?? null;
  const currentWorktreePath = worktree?.worktreePath ?? null;
  const tmuxShortcutLabel =
    useShortcutBindingLabel(SHORTCUT_ACTIONS.streamCopyTmuxAttach, { compact: true }) || "c then t";
  const worktreeShortcutLabel =
    useShortcutBindingLabel(SHORTCUT_ACTIONS.streamCopyWorktreePath, { compact: true }) ||
    "c then w";
  const infoShortcutLabel = useShortcutBindingLabel(SHORTCUT_ACTIONS.panelViewInfo);
  const diffShortcutLabel = useShortcutBindingLabel(SHORTCUT_ACTIONS.panelViewDiff);

  const tmuxCopy = useCopyToClipboard(600);
  const worktreeCopy = useCopyToClipboard(600);
  const branchCopy = useCopyToClipboard(600);
  const baseBranchCopy = useCopyToClipboard(600);
  const cwdCopy = useCopyToClipboard(600);

  useEffect(() => {
    return registerShortcutHandlers([
      {
        actionId: SHORTCUT_ACTIONS.streamCopyTmuxAttach,
        priority: 10,
        handler: () => {
          if (!firstTmuxSession) return false;
          const cmd = `tmux attach -t ${firstTmuxSession}`;
          void tmuxCopy.copy(cmd).catch(() => toast.error("Failed to copy"));
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.streamCopyWorktreePath,
        priority: 10,
        handler: () => {
          if (!currentWorktreePath) return false;
          void worktreeCopy.copy(currentWorktreePath).catch(() => toast.error("Failed to copy"));
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.panelViewInfo,
        handler: () => {
          (document.activeElement as HTMLElement)?.blur?.();
          setActiveScrollContainer("main");
          setPanelView("info");
          return true;
        },
      },
      {
        actionId: SHORTCUT_ACTIONS.panelViewDiff,
        handler: () => {
          if (!hasWorktree) return false;
          (document.activeElement as HTMLElement)?.blur?.();
          setActiveScrollContainer("diff");
          setPanelView("diff");
          return true;
        },
      },
    ]);
  }, [firstTmuxSession, currentWorktreePath, tmuxCopy.copy, worktreeCopy.copy, hasWorktree]);

  const renderedDiff = useMemo(() => {
    if (diffQuery.data?.mode !== "diff") return "";
    return diff2html(diffQuery.data.diff, {
      outputFormat: "line-by-line",
      drawFileList: true,
      matching: "lines",
      colorScheme: resolvedTheme === "dark" ? ColorSchemeType.DARK : ColorSchemeType.LIGHT,
    });
  }, [diffQuery.data, resolvedTheme]);

  if (!piSessionId) {
    return (
      <div className="flex flex-col h-full border-l border-border bg-background">
        <p className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
          Active Sessions
        </p>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-xs text-muted-foreground">Waiting for session…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full border-l border-border bg-background">
      {/* Header row: status banner + diff toggle */}
      <div className="flex justify-between items-center gap-1 mx-3 mt-3 mb-2">
        {(() => {
          const banner = piStatusBanner(piSessionStatus);
          return banner ? (
            <div className={cn("px-3 py-1.5 rounded-md text-xs font-medium", banner.colorClass)}>
              {banner.label}
            </div>
          ) : (
            <div />
          );
        })()}
        <ToggleGroup
          value={[panelView]}
          onValueChange={(newValue) => {
            const val = newValue[newValue.length - 1];
            if (val === "info" || val === "diff") {
              setActiveScrollContainer(val === "diff" ? "diff" : "main");
              setPanelView(val);
            }
          }}
          variant="outline"
          size="sm"
        >
          <ToggleGroupItem
            value="info"
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
          >
            Info
            {infoShortcutLabel && (
              <span className="text-muted-foreground/50 text-[10px] ml-1">{infoShortcutLabel}</span>
            )}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="diff"
            disabled={!hasWorktree}
            className="aria-pressed:bg-accent aria-pressed:text-accent-foreground"
          >
            Diff
            {diffShortcutLabel && (
              <span className="text-muted-foreground/50 text-[10px] ml-1">{diffShortcutLabel}</span>
            )}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      {showDiff && hasWorktree ? (
        /* Diff panel */
        <div data-scroll-container="diff" className="flex-1 overflow-y-auto">
          {diffQuery.isPending && (
            <p className="px-4 py-3 text-[11px] text-muted-foreground">Loading diff…</p>
          )}
          {diffQuery.isError && (
            <p className="px-4 py-3 text-xs text-destructive">Failed to load diff.</p>
          )}
          {diffQuery.isSuccess && !diffQuery.data && (
            <p className="px-4 py-3 text-xs text-muted-foreground">
              No changes against {worktree?.baseBranch ?? "main"}.
            </p>
          )}
          {diffQuery.isSuccess && diffQuery.data?.mode === "summary" && (
            <>
              <div className="mx-3 mt-2 mb-1 px-3 py-1.5 rounded-md text-xs font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400">
                Diff too large ({diffQuery.data.files} files,{" "}
                {diffQuery.data.insertions.toLocaleString()}+ /{" "}
                {diffQuery.data.deletions.toLocaleString()}&minus;) — showing summary only
              </div>
              <pre className="px-4 py-2 text-xs text-muted-foreground whitespace-pre-wrap font-mono overflow-x-auto">
                {diffQuery.data.stat}
              </pre>
            </>
          )}
          {diffQuery.isSuccess && diffQuery.data?.mode === "diff" && (
            <div
              className="diff-viewer-panel text-xs"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: diff HTML is generated server-side by diff2html, not from user input
              dangerouslySetInnerHTML={{ __html: renderedDiff }}
            />
          )}
        </div>
      ) : (
        /* Default sessions + worktree panel */
        <div className="flex-1 overflow-y-auto">
          {worktree?.effectiveCwd && (
            <div className="px-4 pt-3 pb-2 border-b border-border flex items-center gap-1 min-w-0 text-xs text-muted-foreground">
              <span className="shrink-0">CWD:</span>
              <CopyableCode
                text={worktree.effectiveCwd}
                copied={cwdCopy.copied}
                onCopy={() => worktree.effectiveCwd && cwdCopy.copy(worktree.effectiveCwd)}
              />
              <span className="text-muted-foreground/50 text-[10px]">
                {cwdCopy.copied ? "Copied!" : ""}
              </span>
            </div>
          )}
          <p className="px-4 pt-3 pb-2 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
            Active Sessions
          </p>
          {isPending && (
            <p className="px-4 py-3 text-xs text-muted-foreground">Loading sessions…</p>
          )}
          {isError && (
            <p className="px-4 py-3 text-xs text-destructive">Failed to load sessions.</p>
          )}
          {data && data.length === 0 && (
            <p className="px-4 py-3 text-xs text-muted-foreground">No active sessions</p>
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
                      title={statusLabel(session.status)}
                    />
                    <span className="truncate font-mono text-xs text-foreground">
                      {session.sessionId.slice(0, 8)}
                    </span>
                  </div>

                  {session.tmuxSession && (
                    <span className="pl-2 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                      tmux:{" "}
                      {session.sessionId === ctTargetSessionId ? (
                        <CopyableCode
                          text={`tmux attach -t ${session.tmuxSession}`}
                          copied={tmuxCopy.copied}
                          onCopy={() => tmuxCopy.copy(`tmux attach -t ${session.tmuxSession}`)}
                        />
                      ) : (
                        <CopyableCode text={`tmux attach -t ${session.tmuxSession}`} />
                      )}
                      {session.sessionId === ctTargetSessionId && (
                        <span className="text-muted-foreground/50 text-[10px]">
                          {tmuxCopy.copied ? "Copied!" : tmuxShortcutLabel}
                        </span>
                      )}
                    </span>
                  )}

                  <span className="pl-2 text-xs text-muted-foreground truncate">
                    cwd: {sessionDescription(session)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {worktree?.worktreePath && (
            <div className="px-4 py-3 border-t border-border">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                Active Worktree
              </p>
              <div className="flex flex-col gap-0.5 py-1.5">
                <span className="pl-2 truncate text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  Branch:{" "}
                  <CopyableCode
                    text={worktree.name ?? ""}
                    copied={branchCopy.copied}
                    onCopy={() => branchCopy.copy(worktree.name ?? "")}
                  />
                  <span className="text-muted-foreground/50 text-[10px]">
                    {branchCopy.copied ? "Copied!" : ""}
                  </span>
                </span>
                <span className="pl-2 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  Merge Target:{" "}
                  <CopyableCode
                    text={worktree.baseBranch ?? "main"}
                    copied={baseBranchCopy.copied}
                    onCopy={() => baseBranchCopy.copy(worktree.baseBranch ?? "main")}
                  />
                  <span className="text-muted-foreground/50 text-[10px]">
                    {baseBranchCopy.copied ? "Copied!" : ""}
                  </span>
                </span>
                <span className="pl-2 text-xs text-muted-foreground flex items-center gap-1 min-w-0">
                  Worktree:{" "}
                  <CopyableCode
                    text={worktree.worktreePath ?? ""}
                    displayText={(() => {
                      const parts = (worktree.worktreePath ?? "").split("/");
                      const leaf = parts[parts.length - 1] ?? "";
                      return `../${leaf}`;
                    })()}
                    copied={worktreeCopy.copied}
                    onCopy={() => worktreeCopy.copy(worktree.worktreePath ?? "")}
                  />
                  <span className="text-muted-foreground/50 text-[10px]">
                    {worktreeCopy.copied ? "Copied!" : worktreeShortcutLabel}
                  </span>
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
