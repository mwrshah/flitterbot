import { EllipsisVerticalIcon } from "lucide-react";
import { createRoot, type Root } from "react-dom/client";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";

function MessageActionsMenu({ onFork, onPrune }: { onFork: () => void; onPrune: () => void }) {
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

class MessageActionsMenuElement extends HTMLElement {
  entryId?: string;
  private root?: Root;

  connectedCallback(): void {
    this.style.display = "contents";
    this.root = createRoot(this);
    this.root.render(
      <MessageActionsMenu
        onFork={() => this.dispatchAction("fork-message")}
        onPrune={() => this.dispatchAction("prune-message")}
      />,
    );
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = undefined;
  }

  private dispatchAction(name: "fork-message" | "prune-message"): void {
    if (!this.entryId) return;
    this.dispatchEvent(
      new CustomEvent(name, {
        detail: { entryId: this.entryId },
        bubbles: true,
        composed: true,
      }),
    );
  }
}

if (!customElements.get("message-actions-menu")) {
  customElements.define("message-actions-menu", MessageActionsMenuElement);
}
