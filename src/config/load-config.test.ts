import { describe, expect, test } from "bun:test";
import {
  SUGGESTED_TMUX_FIRST_MESSAGE_FOOTER,
  TMUX_SKILL_DIRECTIVE,
  validateKnownConfigKeys,
  validateTmuxStreamFooterConfig,
} from "./load-config.ts";

describe("validateKnownConfigKeys", () => {
  test("allows known top-level config keys and known model keys", () => {
    expect(() =>
      validateKnownConfigKeys(
        {
          controlSurfaceHost: "127.0.0.1",
          controlSurfaceCommand: "node src/server.ts",
          projectRoot: "/repo",
          sourceRoot: "/repo",
          models: [
            {
              id: "sonnet",
              label: "Sonnet",
              provider: "anthropic",
              modelId: "claude-sonnet-4-5",
              thinkingLevel: "low",
            },
          ],
          todoistApiKey: "secret",
          linearApiKey: "secret",
        },
        "/tmp/config.json",
      ),
    ).not.toThrow();
  });

  test("rejects every unknown top-level and model key together", () => {
    expect(() =>
      validateKnownConfigKeys(
        {
          legacyFoo: true,
          models: [
            {
              id: "sonnet",
              label: "Sonnet",
              provider: "anthropic",
              modelId: "claude-sonnet-4-5",
              deprecatedAlias: "old",
            },
          ],
          unusedBar: "x",
        },
        "/tmp/config.json",
      ),
    ).toThrow(
      'Invalid startup config /tmp/config.json: unknown config keys: "legacyFoo", "models[0].deprecatedAlias", "unusedBar". Remove these keys from /tmp/config.json.',
    );
  });
});

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
