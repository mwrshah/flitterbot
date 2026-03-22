import { getRouteApi } from "@tanstack/react-router";
import { Button } from "~/components/ui/Button";
import { Input } from "~/components/ui/Input";
import { useTheme } from "~/hooks/use-theme";
import { useSettings } from "~/lib/settings-store";

const rootApi = getRouteApi("__root__");

const themeOptions = [
  { value: "light" as const, label: "Light", icon: "☀️" },
  { value: "dark" as const, label: "Dark", icon: "🌙" },
  { value: "system" as const, label: "System", icon: "💻" },
];

export function SettingsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { settingsStore } = rootApi.useRouteContext();
  const settings = useSettings(settingsStore);
  const updateSettings = settingsStore.set;
  const { theme, setTheme } = useTheme();

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-80 bg-card border-l border-border z-50 flex flex-col shadow-xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold">Settings</h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors text-lg leading-none"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-5">
          {/* Theme */}
          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Theme
            </h3>
            <div className="flex gap-1.5">
              {themeOptions.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() => setTheme(opt.value)}
                  className={`flex-1 flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                    theme === opt.value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <span>{opt.icon}</span>
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          {/* Connection */}
          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Control Surface
            </h3>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Base URL</label>
              <Input
                value={settings.baseUrl}
                onChange={(e) => updateSettings({ baseUrl: e.target.value })}
                placeholder="http://127.0.0.1:18820"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Bearer token</label>
              <Input
                type="password"
                value={settings.token}
                onChange={(e) => updateSettings({ token: e.target.value })}
                placeholder="controlSurfaceToken"
              />
            </div>
            <label className="flex items-center gap-2.5 text-sm text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={settings.useStubFallback}
                onChange={(e) =>
                  updateSettings({
                    useStubFallback: e.target.checked,
                  })
                }
                className="rounded border-border"
              />
              <span className="text-xs">Use stub fallback when localhost unavailable</span>
            </label>
          </section>
        </div>

        <div className="px-5 py-4 border-t border-border">
          <Button variant="secondary" className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </>
  );
}
