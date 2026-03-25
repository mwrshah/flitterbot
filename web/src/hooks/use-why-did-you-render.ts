import { useEffect, useRef } from "react";

function useWhyDidYouRenderImpl(componentName: string, trackedValues: Record<string, unknown>): void {
  const prevRef = useRef<Record<string, unknown>>(trackedValues);

  useEffect(() => {
    const prev = prevRef.current;
    const allKeys = new Set([...Object.keys(prev), ...Object.keys(trackedValues)]);

    for (const key of allKeys) {
      if (!Object.is(prev[key], trackedValues[key])) {
        console.log(`[WDYR] ${componentName}: ${key} changed`, {
          old: prev[key],
          new: trackedValues[key],
        });
      }
    }

    prevRef.current = trackedValues;
  });
}

function noop(_componentName: string, _trackedValues: Record<string, unknown>): void {}

export const useWhyDidYouRender: (
  componentName: string,
  trackedValues: Record<string, unknown>,
) => void = import.meta.env.DEV ? useWhyDidYouRenderImpl : noop;
