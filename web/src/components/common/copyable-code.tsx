import { cn } from "cn";
import { Tooltip } from "@/components/common/tooltip";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

export function CopyableCode({
  text,
  displayText,
  copied: externalCopied,
  onCopy,
  className,
}: {
  text: string;
  displayText?: string;
  copied?: boolean;
  onCopy?: () => void;
  className?: string;
}) {
  const internal = useCopyToClipboard(600);
  const isControlled = onCopy !== undefined;
  const isCopied = isControlled ? (externalCopied ?? false) : internal.copied;

  return (
    <Tooltip content={`copy \`${text}\``}>
      <button
        type="button"
        onClick={() => (isControlled ? onCopy() : internal.copy(text))}
        className={cn(
          "inline-block max-w-full truncate rounded bg-background-muted px-1.5 py-0.5 text-left text-xs text-text transition-colors hover:bg-background-hover",
          className,
        )}
      >
        {!isControlled && isCopied ? (
          <span className="text-text-muted">Copied!</span>
        ) : (
          <span>{displayText ?? text}</span>
        )}
      </button>
    </Tooltip>
  );
}
