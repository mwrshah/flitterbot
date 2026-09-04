import { useQuery } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { dueTasksQueryOptions } from "@/lib/queries";

function TaskWithDetails({ description, details }: { description: string; details: string }) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();

  return (
    <div className="relative before:absolute before:top-0 before:-left-2 before:h-3.5 before:w-5 before:rounded-bl-md before:border-b before:border-l before:border-border after:absolute after:top-0 after:bottom-0 after:-left-2 after:border-l after:border-border last:after:hidden">
      <p className="px-5 py-1.5 text-sm leading-4 text-text-muted">
        <span className="select-text">{description}</span>{" "}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded((open) => !open)}
          className="cursor-pointer touch-manipulation rounded-sm text-sm text-text-muted underline decoration-dotted underline-offset-2 transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop"
        >
          {expanded ? "less" : "more"}
        </button>
      </p>
      {expanded && (
        <p
          id={detailsId}
          className="mr-1 mb-1 ml-5 whitespace-pre-wrap text-[11px] leading-4 text-text-muted"
        >
          {details}
        </p>
      )}
    </div>
  );
}

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
        className="group pt-3 pb-2 text-[10px] font-medium uppercase tracking-wider text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop"
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
      <div ref={projectsRef} className="space-y-1 pl-1">
        {data?.projects.map((project) => (
          <details key={project.id} open>
            <summary className="flex w-full cursor-pointer touch-manipulation list-none items-center justify-between gap-3 rounded-sm px-1 pb-1 pl-0.5 text-left text-sm text-text-muted transition-colors hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop focus-visible:ring-offset-2 focus-visible:ring-offset-background [&::-webkit-details-marker]:hidden">
              <span className="truncate">{project.name}</span>
              <span className="mr-1 ml-auto text-[10px] font-normal text-text-muted">
                {project.tasks.length}
              </span>
            </summary>
            <div className="ml-[9px] pl-[7px]">
              {project.tasks.map((task) =>
                task.details ? (
                  <TaskWithDetails
                    key={task.id}
                    description={task.description}
                    details={task.details}
                  />
                ) : (
                  <p
                    key={task.id}
                    className="relative cursor-default px-5 py-1.5 text-sm leading-4 text-text-muted before:absolute before:top-0 before:-left-2 before:h-3.5 before:w-5 before:rounded-bl-md before:border-b before:border-l before:border-border after:absolute after:top-0 after:bottom-0 after:-left-2 after:border-l after:border-border last:after:hidden"
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
