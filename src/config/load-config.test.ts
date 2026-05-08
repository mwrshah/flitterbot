import { describe, expect, test } from "bun:test";
import {
  SUGGESTED_TMUX_FIRST_MESSAGE_FOOTER,
  TMUX_SKILL_DIRECTIVE,
  validateTmuxStreamFooterConfig,
} from "./load-config.ts";

describe("validateTmuxStreamFooterConfig", () => {
  test("allows tmux disabled when the stream footer does not load the tmux skill", () => {
    expect(() =>
      validateTmuxStreamFooterConfig({
        tmuxEnabled: false,
        newStreamFirstMessageFooter: "Use notes/tasks operations.",
      }),
    ).not.toThrow();
  });

  test("rejects tmux skill footer when tmux is disabled", () => {
    expect(() =>
      validateTmuxStreamFooterConfig({
        tmuxEnabled: false,
        newStreamFirstMessageFooter: `IMPORTANT! load ${TMUX_SKILL_DIRECTIVE} first`,
      }),
    ).toThrow(/newStreamFirstMessageFooter includes \/skill:tmux but tmuxEnabled is false/);
  });

  test("allows tmux enabled when the stream footer loads the tmux skill", () => {
    expect(() =>
      validateTmuxStreamFooterConfig({
        tmuxEnabled: true,
        newStreamFirstMessageFooter: SUGGESTED_TMUX_FIRST_MESSAGE_FOOTER,
      }),
    ).not.toThrow();
  });

  test("rejects tmux enabled without the tmux skill footer and suggests the exact config line", () => {
    expect(() =>
      validateTmuxStreamFooterConfig({
        tmuxEnabled: true,
        newStreamFirstMessageFooter: "Use notes/tasks operations.",
      }),
    ).toThrow(`Add "newStreamFirstMessageFooter": "${SUGGESTED_TMUX_FIRST_MESSAGE_FOOTER}"`);
  });
});
