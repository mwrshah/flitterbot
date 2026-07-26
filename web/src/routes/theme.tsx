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
  aliases?: string[];
};

const tokenFamilies: Array<{
  name: string;
  description: string;
  tokens: ThemeToken[];
}> = [
  {
    name: "Background",
    description: "Canvas, bounded surfaces, overlays, and grouped regions.",
    tokens: [
      { name: "background", role: "Default application surface" },
      { name: "background-muted", role: "Subtle contrast between panels" },
      { name: "background-hover", role: "Transient pointer or keyboard hover" },
      { name: "background-selected", role: "Persistent selection" },
      { name: "background-pop", role: "Distinctive user-owned region" },
      { name: "background-contrast", role: "Inverse surface; always equals text" },
      {
        name: "background-contrast-muted",
        role: "Muted inverse surface; always equals text-muted",
      },
    ],
  },
  {
    name: "Text",
    description: "Readable hierarchy without opacity-based tiers.",
    tokens: [
      { name: "text", role: "Default foreground" },
      { name: "text-muted", role: "Receding information" },
      { name: "text-pop", role: "Expressive emphasis" },
      { name: "text-contrast", role: "Inverse text; always equals background" },
      { name: "text-contrast-muted", role: "Muted inverse text; always equals background-muted" },
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

const statusTokens: ThemeToken[] = [
  { name: "active", role: "Working, inferring, or connected" },
  { name: "supervising", role: "Waiting on downstream sessions" },
  {
    name: "stale",
    aliases: ["waiting", "info", "idle", "stale"],
    role: "Needs attention without indicating failure",
  },
  { name: "ended", role: "Stopped, disabled, or disconnected" },
  { name: "crashed", role: "Failed or crashed" },
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

function TokenSwatch({ token }: { token: ThemeToken }) {
  const variable = `--${token.name}`;
  const isPopSurface = token.name === "background-pop";
  const swatchStyle = {
    backgroundColor: `var(${variable})`,
    backgroundImage: isPopSurface ? `var(${variable}-image)` : undefined,
  } as CSSProperties;

  return (
    <article className="overflow-hidden rounded-xl border border-border-muted bg-background text-text shadow-sm">
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

function StatusSwatch({ token }: { token: ThemeToken }) {
  const variable = `--status-${token.name}`;
  const names = token.aliases ?? [token.name];

  return (
    <article
      className="rounded-xl p-4"
      style={{
        backgroundColor: `var(${variable}-muted)`,
        color: `var(${variable})`,
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="size-2.5 rounded-full"
          style={{ backgroundColor: `var(${variable})` }}
          aria-hidden="true"
        />
        <h3 className="font-mono text-sm font-semibold">{names.join(" / ")}</h3>
      </div>
      <p className="mt-2 text-xs leading-5 text-text-muted">{token.role}</p>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {names.map((name) => (
          <Code key={name}>status-{name}</Code>
        ))}
      </div>
    </article>
  );
}

function ThemeReferencePage() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  return (
    <main className="alternate-theme h-full overflow-auto bg-background text-text">
      <div className="px-36 py-8 sm:py-12">
        <header className="grid gap-8 border-b border-border-muted pb-10 lg:grid-cols-[1fr_auto] lg:items-end">
          <div className="max-w-3xl">
            <p className="font-mono text-xs font-semibold uppercase tracking-[0.18em] text-text-pop">
              Approved theme · {resolvedTheme}
            </p>
            <h1 className="mt-3 text-balance text-4xl font-semibold tracking-tight text-text sm:text-5xl">
              Eggshell &amp; Signal
            </h1>
            <p className="mt-4 max-w-2xl text-pretty text-base leading-7 text-text-muted">
              A compact semantic color system for Flitterbot. A subtle eggshell canvas stays close
              to the existing interface; a translucent amber signal distinguishes user-owned content
              without turning it into a solid color block.
            </p>
          </div>

          <div
            className="flex w-fit gap-1 rounded-xl border border-border-muted bg-background p-1 shadow-sm"
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
              Approved combinations keep routine states quiet and use pop to distinguish
              identity-bearing surfaces such as user messages.
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <button
              type="button"
              className="min-h-32 rounded-xl border border-border bg-background p-4 text-left outline-none hover:bg-background-hover focus-visible:ring-2 focus-visible:ring-border-pop"
            >
              <span className="block text-sm font-semibold text-text">Default → hover</span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                Hover surfaces acknowledge an interaction without competing with content.
              </span>
              <span className="mt-5 block font-mono text-[10px] text-text-muted">
                hover:bg-background-hover
              </span>
            </button>

            <button
              type="button"
              className="min-h-32 rounded-xl border border-border bg-background-muted p-4 text-left outline-none hover:bg-background-hover focus-visible:ring-2 focus-visible:ring-border-pop"
            >
              <span className="block text-sm font-semibold text-text">Muted → hover</span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                Contrasting panels join the same hover trajectory.
              </span>
              <span className="mt-5 block font-mono text-[10px] text-text-muted">
                bg-background-muted hover:bg-background-hover
              </span>
            </button>

            <div className="min-h-32 rounded-xl border border-border bg-background-selected p-4">
              <span className="flex items-center gap-2 text-sm font-semibold text-text">
                <Check className="size-4" aria-hidden="true" /> Selected
              </span>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                A calm persistent state for streams, tabs, and navigation.
              </span>
              <span className="mt-5 block font-mono text-[10px] text-text-muted">
                bg-background-selected
              </span>
            </div>

            <div className="min-h-32 rounded-xl border border-border bg-background p-4">
              <label htmlFor="theme-focus-input" className="block text-sm font-semibold text-text">
                Keyboard focus
              </label>
              <span className="mt-2 block text-xs leading-5 text-text-muted">
                Focus the input to inspect the high-contrast boundary.
              </span>
              <input
                id="theme-focus-input"
                type="text"
                placeholder="Focus me"
                className="mt-3 min-h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-text outline-none placeholder:text-text-muted focus-visible:ring-2 focus-visible:ring-border-pop"
              />
            </div>

            <div className="min-h-32 rounded-xl border border-border-pop bg-background-pop p-4 text-text">
              <span className="block text-xs font-medium text-text-muted">You</span>
              <span className="mt-2 block text-sm leading-5">
                Make the user’s message distinct without turning it into a solid color block.
              </span>
              <span className="mt-5 block font-mono text-[10px] text-text-muted">
                bg-background-pop border-border-pop
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
              <div
                className={`grid gap-4 sm:grid-cols-2 ${family.name === "Background" ? "lg:grid-cols-5" : "lg:grid-cols-6"}`}
              >
                {family.tokens.map((token) => (
                  <TokenSwatch key={token.name} token={token} />
                ))}
              </div>
            </section>
          ))}
        </div>

        <section
          className="mt-12 border-t border-border-muted pt-10"
          aria-labelledby="status-heading"
        >
          <div className="mb-5 max-w-2xl">
            <h2 id="status-heading" className="text-xl font-semibold text-text">
              Flitterbot status colors
            </h2>
            <p className="mt-1 text-sm leading-6 text-text-muted">
              Application-specific status tokens sit outside the core background, text, and border
              system. Labels and icons carry the same meaning when color is unavailable.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            {statusTokens.map((token) => (
              <StatusSwatch key={token.name} token={token} />
            ))}
          </div>
        </section>

        <section className="mt-12 grid overflow-hidden rounded-2xl border border-border-muted bg-background lg:grid-cols-2">
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
          <div className="grid gap-3 border-t border-border-muted bg-background-muted p-6 sm:p-8 lg:border-l lg:border-t-0">
            <div className="flex items-start gap-3 rounded-xl border border-border-muted bg-background p-3">
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
            <div className="flex items-start gap-3 rounded-xl border border-border-muted bg-background p-3 opacity-55">
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
