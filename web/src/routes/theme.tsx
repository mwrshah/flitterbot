import { createFileRoute } from "@tanstack/react-router";
import { Check, CircleAlert, Info, Monitor, Moon, Sun } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { type Theme, useTheme } from "~/hooks/use-theme";

export const Route = createFileRoute("/theme")({
  head: () => ({
    meta: [{ title: "Theme reference · Flitterbot" }],
  }),
  component: ThemeReferencePage,
});

type ThemeToken = {
  name: string;
  role: string;
};

const tokenFamilies: Array<{
  name: string;
  description: string;
  tokens: ThemeToken[];
}> = [
  {
    name: "Background",
    description: "Page canvas and full-width regions.",
    tokens: [
      { name: "background", role: "Application canvas" },
      { name: "background-muted", role: "Quiet regions and hover" },
      { name: "background-selected", role: "Persistent selection" },
      { name: "background-pop", role: "Distinctive user-owned region" },
    ],
  },
  {
    name: "Card",
    description: "Bounded, raised, floating, or grouped content.",
    tokens: [
      { name: "card", role: "Default bounded surface" },
      { name: "card-muted", role: "Quiet card and hover" },
      { name: "card-selected", role: "Selected card" },
      { name: "card-pop", role: "User message and pop card" },
    ],
  },
  {
    name: "Text",
    description: "Readable hierarchy without opacity-based tiers.",
    tokens: [
      { name: "text", role: "Default foreground" },
      { name: "text-muted", role: "Receding information" },
      { name: "text-pop", role: "Expressive emphasis" },
      { name: "text-contrast", role: "Text on strongly contrasting surfaces" },
      { name: "text-contrast-muted", role: "Muted text on contrasting surfaces" },
    ],
  },
  {
    name: "Border",
    description: "Structure, quiet separation, and strong focus.",
    tokens: [
      { name: "border", role: "Default structure" },
      { name: "border-muted", role: "Subtle separation" },
      { name: "border-pop", role: "Focus and emphasis" },
    ],
  },
];

const utilities = ["bg", "text", "border", "ring", "fill", "stroke"];
const themeOptions: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function Code({ children, contrast = false }: { children: ReactNode; contrast?: boolean }) {
  return (
    <code
      className={
        contrast
          ? "rounded bg-black/10 px-1.5 py-0.5 font-mono text-[11px] text-text-contrast-muted"
          : "rounded bg-background-muted px-1.5 py-0.5 font-mono text-[11px] text-text-muted"
      }
    >
      {children}
    </code>
  );
}

function TokenCard({ token }: { token: ThemeToken }) {
  const variable = `--${token.name}`;
  const isPopSurface = token.name === "background-pop" || token.name === "card-pop";
  const swatchStyle = {
    backgroundColor: `var(${variable})`,
    backgroundImage: isPopSurface ? `var(${variable}-image)` : undefined,
  } as CSSProperties;

  return (
    <article className="overflow-hidden rounded-xl border border-border-muted bg-card text-text shadow-sm">
      <div
        className="h-24 border-b border-border-muted"
        style={swatchStyle}
        aria-label={`${variable} color swatch`}
      />
      <div className="space-y-3 p-4">
        <div>
          <h3 className="font-mono text-sm font-semibold text-text">{token.name}</h3>
          <p className="mt-1 text-xs leading-relaxed text-text-muted">{token.role}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {utilities.map((utility) => (
            <Code key={utility}>
              {utility}-{token.name}
            </Code>
          ))}
        </div>
      </div>
    </article>
  );
}

function ThemeReferencePage() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  return (
    <main className="alternate-theme h-full overflow-auto bg-background text-text">
      <div className="mx-auto max-w-7xl px-5 py-8 sm:px-8 sm:py-12">
        <header className="grid gap-8 border-b border-border-muted pb-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="max-w-3xl">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-text-pop">
              Candidate 01 · {resolvedTheme}
            </p>
            <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight text-text sm:text-5xl">
              Graphite &amp; Signal
            </h1>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-text-muted">
              A compact semantic color system for Flitterbot. Slate-neutral surfaces stay close to
              the existing interface; a translucent amber signal distinguishes user-owned content
              without turning it into a solid color block.
            </p>
          </div>

          <div
            className="flex w-fit gap-1 rounded-xl border border-border-muted bg-card p-1 shadow-sm"
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
                      ? "flex min-h-10 items-center gap-2 rounded-lg bg-background-selected px-3 text-sm font-medium text-text outline-none ring-border-pop focus-visible:ring-2"
                      : "flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-medium text-text-muted outline-none hover:bg-background-muted hover:text-text focus-visible:ring-2 focus-visible:ring-border-pop"
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
              Approved combinations keep routine states quiet and use pop to distinguish
              identity-bearing surfaces such as user messages.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <button
              type="button"
              className="min-h-32 rounded-xl border border-border bg-card p-4 text-left outline-none hover:bg-card-muted focus-visible:ring-2 focus-visible:ring-border-pop"
            >
              <span className="block text-sm font-semibold text-text">Default → hover</span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                Muted surfaces acknowledge an interaction without competing with content.
              </span>
              <span className="mt-5 block font-mono text-[10px] text-text-muted">
                hover:bg-card-muted
              </span>
            </button>

            <div className="min-h-32 rounded-xl border border-border bg-card-selected p-4">
              <span className="flex items-center gap-2 text-sm font-semibold text-text">
                <Check className="size-4" aria-hidden="true" /> Selected
              </span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                A calm persistent state for streams, tabs, and navigation.
              </span>
              <span className="mt-5 block font-mono text-[10px] text-text-muted">
                bg-card-selected
              </span>
            </div>

            <button
              type="button"
              className="min-h-32 rounded-xl border border-border bg-card p-4 text-left outline-none ring-border-pop focus-visible:ring-2"
            >
              <span className="block text-sm font-semibold text-text">Keyboard focus</span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                Press Tab to inspect the high-contrast focus boundary.
              </span>
              <span className="mt-5 block font-mono text-[10px] text-text-muted">
                focus-visible:ring-border-pop
              </span>
            </button>

            <div className="min-h-32 rounded-xl border border-border-pop bg-card-pop p-4 text-text">
              <span className="block text-xs font-medium text-text-muted">You</span>
              <span className="mt-2 block text-sm leading-5">
                Make the user’s message distinct without turning it into a solid color block.
              </span>
              <span className="mt-5 block font-mono text-[10px] text-text-muted">
                bg-card-pop border-border-pop
              </span>
            </div>
          </div>
        </section>

        <div className="space-y-12 border-t border-border-muted pt-10">
          {tokenFamilies.map((family) => (
            <section key={family.name} aria-labelledby={`${family.name.toLowerCase()}-heading`}>
              <div className="mb-5">
                <h2
                  id={`${family.name.toLowerCase()}-heading`}
                  className="text-xl font-semibold text-text"
                >
                  {family.name}
                </h2>
                <p className="mt-1 text-sm text-text-muted">{family.description}</p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {family.tokens.map((token) => (
                  <TokenCard key={token.name} token={token} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <section className="mt-12 grid overflow-hidden rounded-2xl border border-border-muted bg-card lg:grid-cols-2">
          <div className="p-6 sm:p-8">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.15em] text-text-pop">
              Governance
            </p>
            <h2 className="mt-2 text-xl font-semibold text-text">One vocabulary, reviewed here</h2>
            <p className="mt-3 max-w-xl text-sm leading-6 text-text-muted">
              Feature code uses these semantic utilities instead of raw palette shades, arbitrary
              values, or literal colors. New roles enter the theme here before they enter the app.
            </p>
          </div>
          <div className="grid gap-3 border-t border-border-muted bg-card-muted p-6 sm:p-8 lg:border-l lg:border-t-0">
            <div className="flex items-start gap-3 rounded-xl border border-border-muted bg-card p-3">
              <Info className="mt-0.5 size-4 shrink-0 text-text-pop" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-text">
                  Status stays outside the core palette
                </p>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  Icons and labels carry meaning; dedicated status colors can be registered later.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-xl border border-border-muted bg-card p-3 opacity-55">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <div>
                <p className="text-sm font-medium text-text">Disabled is a state, not a color</p>
                <p className="mt-1 text-xs leading-5 text-text-muted">
                  Preserve the semantic pairing and reduce the whole control’s prominence.
                </p>
              </div>
            </div>
          </div>
        </section>

        <footer className="mt-10 border-t border-border-muted pt-6 text-xs leading-5 text-text-muted">
          Live source: <Code>web/src/alternate-theme.css</Code>. Every token exposes background,
          text, border, ring, fill, and stroke utilities.
        </footer>
      </div>
    </main>
  );
}
