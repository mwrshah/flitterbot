import { createFileRoute } from "@tanstack/react-router";
import type { CSSProperties, ReactNode } from "react";
import { Button } from "~/components/common/button";
import { useTheme } from "~/hooks/use-theme";
import { cn } from "~/lib/utils";

export const Route = createFileRoute("/theme")({
  head: () => ({
    meta: [{ title: "Theme reference · Flitterbot" }],
  }),
  component: ThemeReferencePage,
});

type ThemeColor = {
  name: string;
  role: string;
};

const surfaceColors: ThemeColor[] = [
  { name: "background", role: "App canvas" },
  { name: "card", role: "Raised content surface" },
  { name: "popover", role: "Menus and floating surfaces" },
  { name: "primary", role: "Primary actions and strong selection" },
  { name: "secondary", role: "Secondary controls" },
  { name: "muted", role: "Subtle fills and highlights" },
  { name: "accent", role: "Hover, highlight, and selected items" },
  { name: "destructive", role: "Errors and destructive actions" },
];

const textColors: ThemeColor[] = [
  { name: "foreground", role: "Normal text" },
  { name: "card-foreground", role: "Text on cards" },
  { name: "popover-foreground", role: "Text on popovers" },
  { name: "primary-foreground", role: "Text on primary fills" },
  { name: "secondary-foreground", role: "Text on secondary fills" },
  { name: "muted-foreground", role: "Secondary and muted text" },
  { name: "accent-foreground", role: "Text on accent fills" },
  { name: "destructive-foreground", role: "Text on destructive fills" },
];

const borderColors: ThemeColor[] = [
  { name: "border", role: "Dividers and normal borders" },
  { name: "input", role: "Form-control borders and fills" },
  { name: "ring", role: "Keyboard focus rings" },
];

const sidebarColors: ThemeColor[] = [
  { name: "sidebar", role: "Sidebar canvas" },
  { name: "sidebar-foreground", role: "Sidebar text" },
  { name: "sidebar-primary", role: "Sidebar primary action" },
  { name: "sidebar-primary-foreground", role: "Text on sidebar primary" },
  { name: "sidebar-accent", role: "Sidebar hover and highlight" },
  { name: "sidebar-accent-foreground", role: "Text on sidebar accent" },
  { name: "sidebar-border", role: "Sidebar borders" },
  { name: "sidebar-ring", role: "Sidebar focus rings" },
];

const stateRecipes = [
  {
    name: "Base surface",
    classes: "bg-background text-foreground border-border",
    className: "bg-background text-foreground border-border",
  },
  {
    name: "Subtle surface",
    classes: "bg-muted text-muted-foreground border-border",
    className: "bg-muted text-muted-foreground border-border",
  },
  {
    name: "Hover / highlight",
    classes: "hover:bg-accent hover:text-accent-foreground",
    className:
      "bg-background text-foreground border-border hover:bg-accent hover:text-accent-foreground",
  },
  {
    name: "Selected item / tab",
    classes: "bg-accent text-accent-foreground",
    className: "bg-accent text-accent-foreground border-border",
  },
  {
    name: "Primary selection",
    classes: "bg-primary text-primary-foreground",
    className: "bg-primary text-primary-foreground border-primary",
  },
  {
    name: "Keyboard focus",
    classes: "border-ring ring-3 ring-ring/50",
    className: "bg-background text-foreground border-ring ring-3 ring-ring/50",
  },
];

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
      {children}
    </code>
  );
}

function TokenCard({ token }: { token: ThemeColor }) {
  const variable = `--${token.name}`;
  const swatchStyle = { backgroundColor: `var(${variable})` } as CSSProperties;

  return (
    <article className="overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      <div className="h-16 border-b border-border" style={swatchStyle} />
      <div className="space-y-3 p-3">
        <div>
          <h3 className="font-mono text-sm font-medium text-foreground">{token.name}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">{token.role}</p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Code>bg-{token.name}</Code>
          <Code>text-{token.name}</Code>
          <Code>border-{token.name}</Code>
          <Code>fill-{token.name}</Code>
          <Code>stroke-{token.name}</Code>
        </div>
        <p className="font-mono text-[10px] text-muted-foreground/70">var({variable})</p>
      </div>
    </article>
  );
}

function TokenSection({
  title,
  description,
  tokens,
}: {
  title: string;
  description: string;
  tokens: ThemeColor[];
}) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tokens.map((token) => (
          <TokenCard key={token.name} token={token} />
        ))}
      </div>
    </section>
  );
}

function ThemeReferencePage() {
  const { theme, setTheme, resolvedTheme } = useTheme();

  return (
    <main className="h-full overflow-auto bg-background text-foreground">
      <div className="mx-auto max-w-7xl space-y-8 px-6 py-8">
        <header className="flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Tailwind v4 · active theme: {resolvedTheme}
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-foreground">Theme token reference</h1>
            <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
              Live swatches from <Code>web/src/styles.css</Code>. Each semantic color supports
              background, text, border, SVG fill, and SVG stroke utilities; append opacity such as
              <Code> /50</Code> where needed.
            </p>
          </div>
          <div
            className="flex gap-1 rounded-lg border border-border bg-muted/50 p-1"
            aria-label="Theme"
          >
            {(["light", "dark", "system"] as const).map((option) => (
              <Button
                key={option}
                size="sm"
                variant={theme === option ? "default" : "ghost"}
                onClick={() => setTheme(option)}
                className="capitalize"
              >
                {option}
              </Button>
            ))}
          </div>
        </header>

        <section className="space-y-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Interaction recipes</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              State conventions currently composed from the master tokens. Hover the hover sample.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {stateRecipes.map((recipe) => (
              <div
                key={recipe.name}
                className={cn(
                  "flex min-h-24 flex-col justify-between rounded-lg border p-3 transition-colors",
                  recipe.className,
                )}
              >
                <span className="text-sm font-medium">{recipe.name}</span>
                <code className="mt-4 font-mono text-[10px] opacity-75">{recipe.classes}</code>
              </div>
            ))}
          </div>
        </section>

        <TokenSection
          title="Surface fills"
          description="Canvas, container, control, state, and destructive fills."
          tokens={surfaceColors}
        />
        <TokenSection
          title="Text colors"
          description="Foreground pairs intended to sit on their matching fills."
          tokens={textColors}
        />
        <TokenSection
          title="Borders and focus"
          description="The current schema has one general border, one input color, and one focus color."
          tokens={borderColors}
        />
        <TokenSection
          title="Sidebar"
          description="A separate surface family for sidebar contrast and interaction states."
          tokens={sidebarColors}
        />

        <section className="rounded-lg border border-border bg-muted/40 p-4">
          <h2 className="text-sm font-semibold text-foreground">Schema gaps</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            There are no dedicated semantic tokens for selected, hover, success, warning, info,
            subtly accented text, or strong/subtle borders. Those states currently reuse accent,
            muted, primary, opacity modifiers, or raw Tailwind palette colors.
          </p>
        </section>
      </div>
    </main>
  );
}
