import { getRouteApi } from "@tanstack/react-router";
import { Monitor, Moon, Sun, X } from "lucide-react";
import { memo } from "react";
import { AuthProvidersSection } from "@/components/auth-providers-section";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { type Theme, useTheme } from "@/hooks/use-theme";
import { useWhyDidYouRender } from "@/hooks/use-why-did-you-render";
import { useSettings } from "@/lib/settings-store";

const rootApi = getRouteApi("__root__");

const themeOptions: Array<{ value: Theme; label: string; icon: typeof Sun }> = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

export const SettingsDrawer = memo(function SettingsDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  useWhyDidYouRender("SettingsDrawer", { open, onClose });

  const { settingsStore } = rootApi.useRouteContext();
  const settings = useSettings(settingsStore);
  const updateSettings = settingsStore.set;
  const { theme, setTheme } = useTheme();

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        showCloseButton={false}
        className="inset-y-0 right-0 left-auto flex h-full w-full max-w-sm translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-l border-border-muted bg-background p-0 text-text shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-border-muted px-5 py-4">
          <h2 id="settings-title" className="text-sm font-semibold text-text">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="flex size-8 items-center justify-center rounded-lg text-text-muted outline-none hover:bg-background-hover hover:text-text focus-visible:ring-2 focus-visible:ring-border-pop"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 space-y-5 overflow-auto overscroll-contain px-5 py-4">
          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">Theme</h3>
            <div
              className="flex gap-1 rounded-xl border border-border-muted bg-background p-1"
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
                        ? "flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-background-selected px-2 text-xs font-medium text-text outline-none focus-visible:ring-2 focus-visible:ring-border-pop"
                        : "flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg px-2 text-xs font-medium text-text-muted outline-none hover:bg-background-hover hover:text-text focus-visible:ring-2 focus-visible:ring-border-pop"
                    }
                  >
                    <Icon className="size-4" aria-hidden="true" />
                    {label}
                  </button>
                );
              })}
            </div>
          </section>

          <AuthProvidersSection />

          <section className="space-y-3">
            <h3 className="text-xs font-medium uppercase tracking-wider text-text-muted">
              Control Surface
            </h3>
            <div className="space-y-1.5">
              <label htmlFor="settings-base-url" className="text-xs text-text-muted">
                Base URL
              </label>
              <Input
                id="settings-base-url"
                value={settings.baseUrl}
                onChange={(e) => updateSettings({ baseUrl: e.target.value })}
                placeholder="http://127.0.0.1:18820"
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="settings-bearer-token" className="text-xs text-text-muted">
                Bearer token
              </label>
              <Input
                id="settings-bearer-token"
                type="password"
                value={settings.token}
                onChange={(e) => updateSettings({ token: e.target.value })}
                placeholder="controlSurfaceToken"
              />
            </div>
            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-text-muted">
              <input
                type="checkbox"
                checked={settings.useStubFallback}
                onChange={(e) =>
                  updateSettings({
                    useStubFallback: e.target.checked,
                  })
                }
                className="size-4 rounded border-border text-text-pop outline-none focus-visible:ring-2 focus-visible:ring-border-pop"
              />
              <span className="text-xs">Use stub fallback when localhost unavailable</span>
            </label>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
});
