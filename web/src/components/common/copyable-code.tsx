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
    <span
      onClick={() => (isControlled ? onCopy() : internal.copy(text))}
      className="inline-block text-xxs bg-muted/60 hover:bg-muted rounded px-1.5 py-0.5 cursor-pointer truncate max-w-full text-left transition-colors"
      title={`copy \`${text}\``}
    >
      {!isControlled && isCopied ? (
        <span className="text-muted-foreground">Copied!</span>
      ) : (
        <span>{displayText ?? text}</span>
      )}
    </span>
  );
}
