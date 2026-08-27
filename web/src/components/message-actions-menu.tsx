import { EllipsisVerticalIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function MessageActionsMenu({
  onFork,
  onPrune,
}: {
  onFork: () => void;
  onPrune: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label="Message actions"
            className="absolute top-2 right-1.5 cursor-pointer touch-manipulation rounded p-1 text-text-muted hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-pop"
            title="Message actions"
            onClick={(event) => event.stopPropagation()}
          >
            <EllipsisVerticalIcon className="size-4" aria-hidden="true" />
          </button>
        }
      />
      <DropdownMenuContent align="end" className="w-auto min-w-[13rem]">
        <DropdownMenuItem
          className="px-3 py-1.5 text-xs"
          onClick={(event) => {
            event.stopPropagation();
            onFork();
          }}
        >
          Fork above this message
        </DropdownMenuItem>
        <DropdownMenuItem
          variant="destructive"
          className="px-3 py-1.5 text-xs"
          onClick={(event) => {
            event.stopPropagation();
            onPrune();
          }}
        >
          Delete (including me)
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
