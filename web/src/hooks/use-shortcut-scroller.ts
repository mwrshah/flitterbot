import { useEffect, useState } from "react";
import { createShortcutScroller } from "@/lib/shortcut-scroll";

export function useShortcutScroller() {
  const [scroller] = useState(createShortcutScroller);
  useEffect(() => scroller.reset, [scroller]);
  return scroller;
}
