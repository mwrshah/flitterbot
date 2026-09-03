import { useQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useRef } from "react";
import { dueTasksQueryOptions } from "@/lib/queries";

export function DueTasksPanel() {
  const { data, isPending, isError } = useQuery(dueTasksQueryOptions());
  const projectsRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex-1 overflow-y-auto px-3 pb-3 [scrollbar-gutter:auto] [scrollbar-width:thin]">
      <button
        type="button"
        onClick={() => {
          const projects = Array.from(projectsRef.current?.children ?? []).filter(
            (project): project is HTMLDetailsElement => project instanceof HTMLDetailsElement,
          );
          const open = !projects.every((project) => project.open);
          for (const project of projects) project.open = open;
        }}
        className="group px-1 pt-3 pb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop"
      >
        <span className="decoration-dotted underline-offset-2 group-hover:underline">
          Due Tasks
        </span>
      </button>
      {isPending && <p className="px-1 py-3 text-xs text-text-muted">Loading tasks…</p>}
      {isError && <p className="px-1 py-3 text-xs text-status-crashed">Failed to load tasks.</p>}
      {data?.projects.length === 0 && (
        <p className="px-1 py-3 text-xs text-text-muted">No tasks due</p>
      )}
      <div ref={projectsRef} className="space-y-1">
        {data?.projects.map((project) => (
          <details key={project.id} open className="group/project">
            <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-md px-1 py-1.5 text-xs font-medium text-text outline-none hover:bg-background-hover focus-visible:ring-2 focus-visible:ring-border-pop [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 shrink-0 text-text-muted transition-transform group-open/project:rotate-90" />
              <span className="truncate">{project.name}</span>
              <span className="ml-auto text-[10px] font-normal text-text-muted">
                {project.tasks.length}
              </span>
            </summary>
            <div className="ml-2 border-l border-border pl-2">
              {project.tasks.map((task) =>
                task.details ? (
                  <details
                    key={task.id}
                    className="group/task relative before:absolute before:top-0 before:-left-[9px] before:h-3.5 before:w-5 before:rounded-bl-md before:border-b before:border-l before:border-border"
                  >
                    <summary className="flex cursor-pointer list-none items-start rounded-md px-5 py-1.5 text-sm leading-4 text-text outline-none hover:bg-background-hover focus-visible:ring-2 focus-visible:ring-border-pop [&::-webkit-details-marker]:hidden">
                      <span className="underline decoration-dotted underline-offset-2">
                        {task.description}
                      </span>
                    </summary>
                    <p className="mr-1 mb-1 ml-5 whitespace-pre-wrap text-[11px] leading-4 text-text-muted">
                      {task.details}
                    </p>
                  </details>
                ) : (
                  <p
                    key={task.id}
                    className="relative px-5 py-1.5 text-sm leading-4 text-text before:absolute before:top-0 before:-left-[9px] before:h-3.5 before:w-5 before:rounded-bl-md before:border-b before:border-l before:border-border"
                  >
                    {task.description}
                  </p>
                ),
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
