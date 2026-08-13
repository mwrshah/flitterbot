import { createFileRoute } from "@tanstack/react-router";
import { Check, CircleAlert, Info, Monitor, Moon, Sun } from "lucide-react";
import type { ReactNode } from "react";
import { type Theme, useTheme } from "@/hooks/use-theme";

export const Route = createFileRoute("/theme")({
  head: () => ({
    meta: [{ title: "Theme reference · Flitterbot" }],
  }),
  component: ThemeReferencePage,
});

type Token = {
  name: string;
  role: string;
  swatchClass: string;
  previewClass?: string;
  utilities: string[];
};

type StatusToken = {
  name: string;
  role: string;
  dotClass: string;
  surfaceClass: string;
  textClass: string;
};

const backgroundTokens: Token[] = [
  {
    name: "background",
    role: "Ordinary application surface",
    swatchClass: "bg-background",
    utilities: ["bg-background"],
  },
  {
    name: "background-muted",
    role: "Subtle contrast between adjacent panels",
    swatchClass: "bg-background-muted",
    utilities: ["bg-background-muted"],
  },
  {
    name: "background-hover",
    role: "Transient pointer or keyboard interaction",
    swatchClass: "bg-background-hover",
    utilities: ["bg-background-hover"],
  },
  {
    name: "background-selected",
    role: "Quiet, persistent selection",
    swatchClass: "bg-background-selected",
    utilities: ["bg-background-selected"],
  },
  {
    name: "background-pop",
    role: "Expressive, identity-bearing surface",
    swatchClass: "bg-background-pop",
    utilities: ["bg-background-pop"],
  },
  {
    name: "background-contrast",
    role: "Inverse surface paired with contrast text",
    swatchClass: "bg-background-contrast",
    utilities: ["bg-background-contrast"],
  },
  {
    name: "background-contrast-muted",
    role: "Muted inverse surface",
    swatchClass: "bg-background-contrast-muted",
    utilities: ["bg-background-contrast-muted"],
  },
];

const textTokens: Token[] = [
  {
    name: "text",
    role: "Default foreground",
    swatchClass: "text-text",
    utilities: ["text-text"],
  },
  {
    name: "text-muted",
    role: "Receding information",
    swatchClass: "text-text-muted",
    utilities: ["text-text-muted"],
  },
  {
    name: "text-pop",
    role: "Reviewed emphasis",
    swatchClass: "text-text-pop",
    utilities: ["text-text-pop"],
  },
  {
    name: "text-contrast",
    role: "Foreground for inverse surfaces",
    swatchClass: "text-text-contrast",
    previewClass: "bg-background-contrast",
    utilities: ["text-text-contrast"],
  },
  {
    name: "text-contrast-muted",
    role: "Muted foreground for inverse surfaces",
    swatchClass: "text-text-contrast-muted",
    previewClass: "bg-background-contrast-muted",
    utilities: ["text-text-contrast-muted"],
  },
];

const borderTokens: Token[] = [
  {
    name: "border",
    role: "Ordinary structure",
    swatchClass: "border-border",
    utilities: ["border-border", "ring-border"],
  },
  {
    name: "border-muted",
    role: "Quiet separation",
    swatchClass: "border-border-muted",
    utilities: ["border-border-muted", "ring-border-muted"],
  },
  {
    name: "border-pop",
    role: "Keyboard focus and deliberate emphasis",
    swatchClass: "border-border-pop",
    utilities: ["border-border-pop", "ring-border-pop"],
  },
];

const statusTokens: StatusToken[] = [
  {
    name: "active",
    role: "Working, inferring, or connected",
    dotClass: "bg-status-active",
    surfaceClass: "bg-status-active-muted",
    textClass: "text-status-active",
  },
  {
    name: "supervising",
    role: "Waiting on downstream sessions",
    dotClass: "bg-status-supervising",
    surfaceClass: "bg-status-supervising-muted",
    textClass: "text-status-supervising",
  },
  {
    name: "waiting",
    role: "Waiting for input or work",
    dotClass: "bg-status-waiting",
    surfaceClass: "bg-status-waiting-muted",
    textClass: "text-status-waiting",
  },
  {
    name: "info",
    role: "Informational attention",
    dotClass: "bg-status-info",
    surfaceClass: "bg-status-info-muted",
    textClass: "text-status-info",
  },
  {
    name: "idle",
    role: "Available but inactive",
    dotClass: "bg-status-idle",
    surfaceClass: "bg-status-idle-muted",
    textClass: "text-status-idle",
  },
  {
    name: "stale",
    role: "Activity may no longer be current",
    dotClass: "bg-status-stale",
    surfaceClass: "bg-status-stale-muted",
    textClass: "text-status-stale",
  },
  {
    name: "ended",
    role: "Stopped or disconnected",
    dotClass: "bg-status-ended",
    surfaceClass: "bg-status-ended-muted",
    textClass: "text-status-ended",
  },
  {
    name: "crashed",
    role: "Failed or crashed",
    dotClass: "bg-status-crashed",
    surfaceClass: "bg-status-crashed-muted",
    textClass: "text-status-crashed",
  },
];

const themeOptions: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded-md bg-background-muted px-1.5 py-1 font-mono text-[11px] text-text-muted">
      {children}
    </code>
  );
}

function TokenCard({ token, kind }: { token: Token; kind: "background" | "text" | "border" }) {
  const previewClass = token.previewClass ?? "bg-background";

  return (
    <article className="overflow-hidden rounded-xl border border-border-muted bg-background">
      {kind === "background" && (
        <div
          className={`h-24 border-b border-border-muted ${token.swatchClass}`}
          aria-label={`${token.name} live swatch`}
        />
      )}
      {kind === "text" && (
        <div
          className={`flex h-24 items-center justify-center border-b border-border-muted ${previewClass}`}
        >
          <span className={`text-4xl font-semibold ${token.swatchClass}`}>Aa</span>
        </div>
      )}
      {kind === "border" && (
        <div className="flex h-24 items-center justify-center border-b border-border-muted bg-background-muted">
          <div className={`size-14 rounded-xl border-4 bg-background ${token.swatchClass}`} />
        </div>
      )}
      <div className="space-y-3 p-4">
        <div>
          <h3 className="font-mono text-sm font-semibold text-text">{token.name}</h3>
          <p className="mt-1 text-xs leading-5 text-text-muted">{token.role}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {token.utilities.map((utility) => (
            <Code key={utility}>{utility}</Code>
          ))}
        </div>
      </div>
    </article>
  );
}

function StatusCard({ token }: { token: StatusToken }) {
  return (
    <article className={`rounded-xl p-4 ${token.surfaceClass}`}>
      <div className="flex items-center gap-2">
        <span className={`size-2.5 rounded-full ${token.dotClass}`} aria-hidden="true" />
        <h3 className={`font-mono text-sm font-semibold ${token.textClass}`}>{token.name}</h3>
      </div>
      <p className="mt-2 text-xs leading-5 text-text-muted">{token.role}</p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <Code>bg-status-{token.name}</Code>
        <Code>bg-status-{token.name}-muted</Code>
        <Code>text-status-{token.name}</Code>
      </div>
    </article>
  );
}

function FamilySection({
  id,
  title,
  description,
  tokens,
  kind,
}: {
  id: string;
  title: string;
  description: string;
  tokens: Token[];
  kind: "background" | "text" | "border";
}) {
  return (
    <section aria-labelledby={id}>
      <div className="mb-5 max-w-2xl">
        <h2 id={id} className="text-xl font-semibold text-text">
          {title}
        </h2>
        <p className="mt-1 text-sm leading-6 text-text-muted">{description}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {tokens.map((token) => (
          <TokenCard key={token.name} token={token} kind={kind} />
        ))}
      </div>
    </section>
  );
}

function ThemeReferencePage() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  return (
    <main className="h-full overflow-auto bg-background text-text">
      <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-8 sm:py-12 lg:px-12">
        <header className="grid gap-8 border-b border-border-muted pb-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="max-w-3xl">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-text-pop">
              Global theme · {resolvedTheme}
            </p>
            <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight text-text sm:text-5xl">
              Canonical theme audit
            </h1>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-text-muted">
              This page uses the same global semantic tokens as every application surface. Switch
              appearance to review each live utility and interaction recipe in place.
            </p>
          </div>

          <div
            className="flex w-fit gap-1 rounded-xl border border-border-muted bg-background p-1"
            aria-label="Theme appearance"
          >
            {themeOptions.map(({ value, label, icon: Icon }) => {
              const selected = theme === value;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setTheme(value)}
                  className={
                    selected
                      ? "flex min-h-10 items-center gap-2 rounded-lg bg-background-selected px-3 text-sm font-medium text-text outline-none focus-visible:ring-2 focus-visible:ring-border-pop"
                      : "flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-text-muted outline-none hover:bg-background-hover hover:text-text focus-visible:ring-2 focus-visible:ring-border-pop"
                  }
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </button>
              );
            })}
          </div>
        </header>

        <section className="py-10" aria-labelledby="recipes-heading">
          <div className="mb-5 max-w-2xl">
            <h2 id="recipes-heading" className="text-xl font-semibold text-text">
              Interaction recipes
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-muted">
              Hover is transient, selection persists, focus pops the input border, and disabled
              controls retain their semantic pairing.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <button
              type="button"
              className="min-h-36 rounded-xl border border-border bg-background p-4 text-left outline-none hover:bg-background-hover focus-visible:ring-2 focus-visible:ring-border-pop"
            >
              <span className="block text-sm font-semibold text-text">Background → hover</span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                The ordinary surface follows the shared transient interaction tier.
              </span>
              <span className="mt-5 block font-mono text-[11px] text-text-muted">
                bg-background hover:bg-background-hover
              </span>
            </button>

            <button
              type="button"
              className="min-h-36 rounded-xl border border-border bg-background-muted p-4 text-left outline-none hover:bg-background-hover focus-visible:ring-2 focus-visible:ring-border-pop"
            >
              <span className="block text-sm font-semibold text-text">Muted → hover</span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                Muted panels converge on the same hover tier instead of inventing another state.
              </span>
              <span className="mt-5 block font-mono text-[11px] text-text-muted">
                bg-background-muted hover:bg-background-hover
              </span>
            </button>

            <div className="min-h-36 rounded-xl border border-border bg-background-selected p-4">
              <span className="flex items-center gap-2 text-sm font-semibold text-text">
                <Check className="size-4" aria-hidden="true" /> Persistent selection
              </span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                Selection remains visibly distinct from both default and hover surfaces.
              </span>
              <span className="mt-5 block font-mono text-[11px] text-text-muted">
                bg-background-selected
              </span>
            </div>

            <div className="min-h-36 rounded-xl border border-border bg-background p-4">
              <label htmlFor="theme-focus-input" className="block text-sm font-semibold text-text">
                Keyboard focus
              </label>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                Tab to the real input to inspect the border-pop focus boundary.
              </span>
              <input
                id="theme-focus-input"
                name="theme-focus-example"
                type="text"
                autoComplete="off"
                placeholder="Focus me…"
                className="mt-3 min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base text-text outline-none placeholder:text-text-muted focus-visible:border-border-pop focus-visible:ring-2 focus-visible:ring-border-pop"
              />
            </div>

            <div className="min-h-36 rounded-xl border border-border-pop bg-background-pop p-4 text-text">
              <span className="block text-xs font-medium text-text-muted">You</span>
              <span className="mt-2 block text-sm leading-5">
                Pop identifies the user’s message without introducing a component-owned color.
              </span>
              <span className="mt-5 block font-mono text-[11px] text-text-muted">
                bg-background-pop border-border-pop
              </span>
            </div>

            <div className="grid min-h-36 overflow-hidden rounded-xl border border-border-muted sm:grid-cols-2">
              <div className="bg-background-contrast p-4 text-text-contrast">
                <span className="block text-sm font-semibold">Contrast</span>
                <span className="mt-2 block text-xs leading-5">Strong inverse pairing</span>
              </div>
              <div className="bg-background-contrast-muted p-4 text-text-contrast-muted">
                <span className="block text-sm font-semibold">Muted contrast</span>
                <span className="mt-2 block text-xs leading-5">Quiet inverse pairing</span>
              </div>
            </div>

            <button
              type="button"
              disabled
              className="min-h-28 rounded-xl border border-border bg-background px-4 text-left text-text opacity-50"
            >
              <span className="block text-sm font-semibold">Disabled control</span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                State opacity applies to the whole semantic control.
              </span>
            </button>
          </div>
        </section>

        <div className="space-y-12 border-t border-border-muted pt-10">
          <FamilySection
            id="background-heading"
            title="Background utilities"
            description="Every surface follows one trajectory from ordinary through persistent selection."
            tokens={backgroundTokens}
            kind="background"
          />
          <FamilySection
            id="text-heading"
            title="Text utilities"
            description="Readable hierarchy without opacity-built color tiers."
            tokens={textTokens}
            kind="text"
          />
          <FamilySection
            id="border-heading"
            title="Border utilities"
            description="Borders provide structure; rings render the same approved semantic roles."
            tokens={borderTokens}
            kind="border"
          />
        </div>

        <section
          className="mt-12 border-t border-border-muted pt-10"
          aria-labelledby="status-heading"
        >
          <div className="mb-5 max-w-2xl">
            <h2 id="status-heading" className="text-xl font-semibold text-text">
              Flitterbot status utilities
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-muted">
              Domain statuses remain separate from the core families. Every example pairs color with
              a visible label and uses no status-colored border.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {statusTokens.map((token) => (
              <StatusCard key={token.name} token={token} />
            ))}
          </div>
        </section>

        <section
          className="mt-12 border-t border-border-muted pt-10"
          aria-labelledby="specialist-heading"
        >
          <div className="mb-5 max-w-2xl">
            <h2 id="specialist-heading" className="text-xl font-semibold text-text">
              Specialist contracts
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-muted">
              Syntax, diff, and scrim colors carry narrow meanings and do not become general UI
              tiers.
            </p>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <article className="overflow-hidden rounded-xl border border-border-muted bg-background">
              <div className="border-b border-border-muted px-4 py-3">
                <h3 className="text-sm font-semibold text-text">Syntax</h3>
                <p className="mt-1 text-xs text-text-muted">Live highlight adapter</p>
              </div>
              <pre className="overflow-x-auto bg-background-muted p-4 text-sm text-text">
                <code>
                  <span className="hljs-keyword">const</span>{" "}
                  <span className="hljs-title function_">renderTheme</span> = ({"{"}
                  <span className="hljs-attr">mode</span>:{" "}
                  <span className="hljs-string">"global"</span>
                  {"}"}) <span className="hljs-keyword">=&gt;</span> {"{"}
                  {"\n  "}
                  <span className="hljs-comment">{"// one canonical source"}</span>
                  {"\n  "}
                  <span className="hljs-keyword">return</span>{" "}
                  <span className="hljs-literal">true</span>
                  {";\n"}
                  {"};"}
                </code>
              </pre>
            </article>

            <article className="overflow-hidden rounded-xl border border-border-muted bg-background">
              <div className="border-b border-border-muted px-4 py-3">
                <h3 className="text-sm font-semibold text-text">Diff</h3>
                <p className="mt-1 text-xs text-text-muted">Live insert and delete adapter</p>
              </div>
              <div className="diff-viewer-panel overflow-x-auto p-4 text-sm">
                <table className="diff">
                  <tbody>
                    <tr className="diff-line diff-line-delete">
                      <td className="diff-gutter diff-gutter-delete">1</td>
                      <td className="diff-code diff-code-delete">− route-local theme scope</td>
                    </tr>
                    <tr className="diff-line diff-line-insert">
                      <td className="diff-gutter diff-gutter-insert">1</td>
                      <td className="diff-code diff-code-insert">+ global canonical theme</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </article>

            <article className="overflow-hidden rounded-xl border border-border-muted bg-background">
              <div className="border-b border-border-muted px-4 py-3">
                <h3 className="text-sm font-semibold text-text">Scrim</h3>
                <p className="mt-1 text-xs text-text-muted">Overlay-only specialist utility</p>
              </div>
              <div className="relative m-4 min-h-40 overflow-hidden rounded-lg border border-border bg-background-muted p-4">
                <p className="text-sm text-text-muted">Application content behind an overlay</p>
                <div className="absolute inset-0 flex items-center justify-center bg-scrim/60 p-4">
                  <div className="rounded-lg border border-border bg-background p-4 text-sm font-medium text-text">
                    Modal surface
                  </div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section className="mt-12 grid overflow-hidden rounded-2xl border border-border-muted bg-background lg:grid-cols-2">
          <div className="p-6 sm:p-8">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.15em] text-text-pop">
              Governance
            </p>
            <h2 className="mt-2 text-xl font-semibold text-text">One global vocabulary</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-text-muted">
              Application code selects canonical core or specialist roles. New roles are defined
              centrally and reviewed here before use.
            </p>
          </div>
          <div className="grid gap-3 border-t border-border-muted bg-background-muted p-6 sm:p-8 lg:border-l lg:border-t-0">
            <div className="flex items-start gap-3 rounded-xl border border-border-muted bg-background p-3">
              <Info className="mt-0.5 size-4 shrink-0 text-text-pop" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-text">Core roles describe UI hierarchy</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  Surfaces, text, and borders stay independent from domain meaning.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-border-muted bg-background p-3">
              <CircleAlert
                className="mt-0.5 size-4 shrink-0 text-status-waiting"
                aria-hidden="true"
              />
              <div>
                <p className="text-sm font-medium text-text">Specialists keep their meaning</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  Status, syntax, diff, and scrim contracts remain outside the core palette.
                </p>
              </div>
            </div>
          </div>
        </section>

        <footer className="mt-10 border-t border-border-muted pt-6 text-xs leading-5 text-text-muted">
          Live source: <Code>web/src/styles.css</Code>. This route contains no theme values or local
          token scope.
        </footer>
      </div>
    </main>
  );
}
