import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "~/components/common/badge";
import { Button } from "~/components/common/button";
import { Input } from "~/components/common/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import type {
  AuthFlowSnapshot,
  AuthMethodType,
  AuthProvider,
  AuthProviderMethod,
} from "~/lib/types";

const rootApi = getRouteApi("__root__");

const AUTH_PROVIDERS_QUERY_KEY = ["auth-providers"] as const;

export const AuthProvidersSection = memo(function AuthProvidersSection() {
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: AUTH_PROVIDERS_QUERY_KEY,
    queryFn: () => apiClient.listAuthProviders(),
    staleTime: 30_000,
  });

  const [activeFlowId, setActiveFlowId] = useState<string | null>(null);
  const [logoutTarget, setLogoutTarget] = useState<AuthProvider | null>(null);

  const loginMutation = useMutation({
    mutationFn: ({ providerId, authType }: { providerId: string; authType: AuthMethodType }) =>
      apiClient.startAuthLogin(providerId, authType),
    onSuccess: (snapshot) => setActiveFlowId(snapshot.id),
    onError: (err) => toast.error(`Login failed: ${messageOf(err)}`),
  });

  const logoutMutation = useMutation({
    mutationFn: (providerId: string) => apiClient.logoutAuthProvider(providerId),
    onSuccess: () => {
      setLogoutTarget(null);
      queryClient.invalidateQueries({ queryKey: AUTH_PROVIDERS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ["models"] });
      toast.success("Signed out");
    },
    onError: (err) => toast.error(`Sign out failed: ${messageOf(err)}`),
  });

  const providers = data?.providers ?? [];

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Accounts &amp; Model providers
        </h3>
        {isError && (
          <button
            type="button"
            onClick={() => refetch()}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            Retry
          </button>
        )}
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading providers…</p>
      ) : isError ? (
        <p className="text-xs text-destructive">Failed to load providers: {messageOf(error)}</p>
      ) : providers.length === 0 ? (
        <p className="text-xs text-muted-foreground">No model providers available.</p>
      ) : (
        <ul className="space-y-1.5">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              busy={loginMutation.isPending || logoutMutation.isPending}
              onLogin={(authType) => loginMutation.mutate({ providerId: provider.id, authType })}
              onLogout={() => setLogoutTarget(provider)}
            />
          ))}
        </ul>
      )}

      {activeFlowId && (
        <AuthFlowDialog
          flowId={activeFlowId}
          onClose={() => {
            setActiveFlowId(null);
            queryClient.invalidateQueries({ queryKey: AUTH_PROVIDERS_QUERY_KEY });
            queryClient.invalidateQueries({ queryKey: ["models"] });
          }}
        />
      )}

      <LogoutConfirmDialog
        provider={logoutTarget}
        pending={logoutMutation.isPending}
        onCancel={() => setLogoutTarget(null)}
        onConfirm={() => logoutTarget && logoutMutation.mutate(logoutTarget.id)}
      />
    </section>
  );
});

function ProviderRow({
  provider,
  busy,
  onLogin,
  onLogout,
}: {
  provider: AuthProvider;
  busy: boolean;
  onLogin: (authType: AuthMethodType) => void;
  onLogout: () => void;
}) {
  const isConnected = Boolean(provider.credentialType);

  return (
    <li className="rounded-lg border border-border bg-background/40 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground">{provider.name}</span>
            {isConnected && (
              <Badge variant="success" className="shrink-0">
                {provider.credentialType}
              </Badge>
            )}
          </div>
        </div>
        {isConnected && (
          <Button variant="ghost" size="sm" onClick={onLogout} disabled={busy}>
            Sign out
          </Button>
        )}
      </div>

      {provider.methods.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {provider.methods.map((method) => (
            <Button
              key={`${method.type}:${method.name}`}
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onLogin(method.type)}
            >
              {loginLabel(method)}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}

function loginLabel(method: AuthProviderMethod): string {
  if (method.loginLabel) return method.loginLabel;
  return method.type === "oauth" ? `Sign in with ${method.name}` : `Add ${method.name} key`;
}

function AuthFlowDialog({ flowId, onClose }: { flowId: string; onClose: () => void }) {
  const { apiClient } = rootApi.useRouteContext();
  const queryClient = useQueryClient();
  const flowQueryKey = ["auth-flow", flowId] as const;

  // Poll while the flow is running so OAuth callbacks / device approvals surface.
  const { data: snapshot, error } = useQuery({
    queryKey: flowQueryKey,
    queryFn: () => apiClient.getAuthFlow(flowId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1500 : false),
  });

  const respondMutation = useMutation({
    mutationFn: ({ promptId, value }: { promptId: string; value: string }) =>
      apiClient.respondAuthFlow(flowId, promptId, value),
    onMutate: () => queryClient.cancelQueries({ queryKey: flowQueryKey }),
    onSuccess: (next) => queryClient.setQueryData(flowQueryKey, next),
    onError: (err) => toast.error(`Submit failed: ${messageOf(err)}`),
  });

  const cancelMutation = useMutation({
    mutationFn: () => apiClient.cancelAuthFlow(flowId),
    onMutate: () => queryClient.cancelQueries({ queryKey: flowQueryKey }),
    onSuccess: (next) => {
      queryClient.setQueryData(flowQueryKey, next);
      onClose();
    },
    onError: (err) => toast.error(`Cancel failed: ${messageOf(err)}`),
  });

  const status = snapshot?.status ?? "running";
  const terminal = status === "succeeded" || status === "failed" || status === "cancelled";

  useEffect(() => {
    if (status === "succeeded") toast.success("Signed in");
  }, [status]);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          if (!terminal) cancelMutation.mutate();
          else onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{titleForStatus(status)}</DialogTitle>
          <DialogDescription>Authentication flow</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {error && !snapshot && (
            <p className="text-xs text-destructive">Could not load flow: {messageOf(error)}</p>
          )}

          {snapshot?.events.length ? (
            <ul className="space-y-2">
              {snapshot.events.map((event, index) => (
                <li key={`${event.type}:${index}`} className="text-sm">
                  <AuthEventView event={event} />
                </li>
              ))}
            </ul>
          ) : null}

          {snapshot?.error && <p className="text-xs text-destructive">{snapshot.error}</p>}

          {status === "running" && snapshot?.prompt && (
            <AuthPromptForm
              key={snapshot.prompt.id}
              prompt={snapshot.prompt}
              pending={respondMutation.isPending}
              onSubmit={(value) =>
                snapshot.prompt && respondMutation.mutate({ promptId: snapshot.prompt.id, value })
              }
            />
          )}

          {status === "running" && !snapshot?.prompt && (
            <p className="text-xs text-muted-foreground">Waiting for the provider…</p>
          )}
        </div>

        <div className="flex justify-end gap-2">
          {terminal ? (
            <Button variant="secondary" size="sm" onClick={onClose}>
              Done
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => cancelMutation.mutate()}
              disabled={cancelMutation.isPending}
            >
              Cancel
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AuthEventView({ event }: { event: AuthFlowSnapshot["events"][number] }) {
  if (event.type === "auth_url") {
    return (
      <div className="space-y-1">
        {event.instructions && <p className="text-muted-foreground">{event.instructions}</p>}
        <a
          href={event.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary underline underline-offset-2"
        >
          Open authentication page
        </a>
      </div>
    );
  }
  if (event.type === "device_code") {
    return (
      <div className="space-y-1">
        <a
          href={event.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-primary underline underline-offset-2"
        >
          Open verification page
        </a>
        <code className="block rounded bg-muted px-2 py-1 font-mono text-base tracking-widest">
          {event.userCode}
        </code>
      </div>
    );
  }
  if (event.type === "info") {
    return (
      <div className="space-y-1">
        <p className="text-muted-foreground">{event.message}</p>
        {event.links?.map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block break-all text-primary underline underline-offset-2"
          >
            {link.label ?? link.url}
          </a>
        ))}
      </div>
    );
  }
  return <p className="text-muted-foreground">{event.message}</p>;
}

function AuthPromptForm({
  prompt,
  pending,
  onSubmit,
}: {
  prompt: NonNullable<AuthFlowSnapshot["prompt"]>;
  pending: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const isSecret = prompt.type === "secret";

  const submit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = value.trim();
      if (!trimmed) {
        setValidationError("Enter a value.");
        return;
      }
      setValidationError(null);
      onSubmit(trimmed);
      // Secrets must not be retained in component state after submit.
      if (isSecret) setValue("");
    },
    [value, isSecret, onSubmit],
  );

  return (
    <form onSubmit={submit} className="space-y-2">
      <label htmlFor={`auth-prompt-${prompt.id}`} className="block text-sm text-foreground">
        {prompt.message}
      </label>

      {prompt.type === "select" ? (
        <div className="flex flex-col gap-1.5">
          {(prompt.options ?? []).map((opt) => (
            <Button
              key={opt.id}
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => onSubmit(opt.id)}
              title={opt.description}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            id={`auth-prompt-${prompt.id}`}
            type={isSecret ? "password" : "text"}
            value={value}
            autoComplete={isSecret ? "off" : undefined}
            onChange={(e) => {
              setValue(e.target.value);
              if (validationError) setValidationError(null);
            }}
            placeholder={prompt.placeholder}
            disabled={pending}
            aria-invalid={Boolean(validationError)}
            aria-describedby={validationError ? `auth-prompt-error-${prompt.id}` : undefined}
          />
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? "Submitting…" : "Submit"}
          </Button>
        </div>
      )}
      {validationError && (
        <p id={`auth-prompt-error-${prompt.id}`} className="text-xs text-destructive" role="alert">
          {validationError}
        </p>
      )}
    </form>
  );
}

function LogoutConfirmDialog({
  provider,
  pending,
  onCancel,
  onConfirm,
}: {
  provider: AuthProvider | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={Boolean(provider)} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Sign out of {provider?.name}?</DialogTitle>
          <DialogDescription>
            This removes the stored credentials for this provider. You will need to sign in again to
            use its models.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={pending}>
            Sign out
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function titleForStatus(status: AuthFlowSnapshot["status"]): string {
  switch (status) {
    case "succeeded":
      return "Signed in";
    case "failed":
      return "Sign in failed";
    case "cancelled":
      return "Sign in cancelled";
    default:
      return "Signing in…";
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
