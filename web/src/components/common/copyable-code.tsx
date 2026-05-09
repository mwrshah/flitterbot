import { useCopyToClipboard } from "~/hooks/use-copy-to-clipboard";

export function CopyableCode({
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
      className="inline-block max-w-full truncate rounded bg-muted/60 px-1.5 py-0.5 text-left text-xs transition-colors hover:bg-muted"
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
