import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useCallback } from "react";
import { userConfigQueryOptions } from "~/lib/queries";

const rootApi = getRouteApi("__root__");

export function useUserConfig() {
  const queryClient = useQueryClient();
  const { apiClient } = rootApi.useRouteContext();
  const { data: config = {} } = useQuery(userConfigQueryOptions(apiClient));

  const { mutate } = useMutation({
    mutationFn: (entries: Record<string, string>) =>
      apiClient.setUserConfig("default_user", entries),
    onMutate: async (entries) => {
      await queryClient.cancelQueries({ queryKey: ["user-config"] });
      const previous = queryClient.getQueryData<Record<string, string>>(["user-config"]);
      queryClient.setQueryData<Record<string, string>>(["user-config"], (prev) => ({
        ...prev,
        ...entries,
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["user-config"], context.previous);
      }
    },
  });

  const setConfig = useCallback(
    (key: string, value: string) => {
      mutate({ [key]: value });
    },
    [mutate],
  );

  return { config, setConfig };
}

/**
 * Parse a stored panel layout string back to a Layout object, or return the fallback.
 * Layout is { [panelId: string]: number }.
 */
export function parsePanelLayout(
  config: Record<string, string>,
  key: string,
  fallback: Record<string, number>,
): Record<string, number> {
  const raw = config[key];
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const fallbackKeys = Object.keys(fallback);
    const parsedKeys = Object.keys(parsed);
    if (parsedKeys.length !== fallbackKeys.length || !parsedKeys.every((k) => k in fallback))
      return fallback;
    for (const v of Object.values(parsed)) {
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) return fallback;
    }
    return parsed as Record<string, number>;
  } catch {
    return fallback;
  }
}
