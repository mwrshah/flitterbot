import { chromium } from "playwright-core";

const [, , urlArgument, expectedVariant, iterationsArgument = "100", samplesArgument = "5"] =
  process.argv;
if (!urlArgument || !expectedVariant) {
  throw new Error(
    "Usage: pnpm bench:router-browser <url> <tanstack|anonrig> [iterations] [samples]",
  );
}

const baseUrl = new URL(urlArgument);
const iterations = Number.parseInt(iterationsArgument, 10);
const samples = Number.parseInt(samplesArgument, 10);
const warmup = Math.min(20, Math.max(5, Math.round(iterations / 10)));

if (!Number.isFinite(iterations) || iterations < 1 || !Number.isFinite(samples) || samples < 1) {
  throw new Error("Iterations and samples must be positive integers");
}

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--disable-background-timer-throttling", "--disable-renderer-backgrounding"],
});

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(15_000);
  await page.goto(new URL("/", baseUrl).href, { waitUntil: "networkidle" });

  const actualVariant = await page
    .locator('meta[name="flitterbot-router"]')
    .getAttribute("content");
  if (actualVariant !== expectedVariant) {
    throw new Error(
      `Expected ${expectedVariant} at ${baseUrl.origin}, but the server reports ${actualVariant ?? "no router variant"}`,
    );
  }

  const result = await page.evaluate(
    async ({ iterations, samples, warmup }) => {
      const waitFor = async (find, description) => {
        const deadline = performance.now() + 10_000;
        while (performance.now() < deadline) {
          const match = find();
          if (match) return match;
          await new Promise(requestAnimationFrame);
        }
        throw new Error(`Timed out waiting for ${description}`);
      };

      const findHealthButton = () =>
        [...document.querySelectorAll("button")].find((element) =>
          element.textContent?.includes("WhatsApp:"),
        );

      const navigateCycle = async () => {
        const healthButton = await waitFor(findHealthButton, "the runtime health button");
        healthButton.click();
        await waitFor(
          () =>
            [...document.querySelectorAll("h1")].find(
              (element) => element.textContent?.trim() === "Runtime",
            ),
          "the Runtime page",
        );
        history.back();
        await waitFor(findHealthButton, "the Surface page");
      };

      for (let index = 0; index < warmup; index += 1) await navigateCycle();

      const durations = [];
      for (let sample = 0; sample < samples; sample += 1) {
        const startedAt = performance.now();
        for (let index = 0; index < iterations; index += 1) await navigateCycle();
        durations.push(performance.now() - startedAt);
      }

      return durations;
    },
    { iterations, samples, warmup },
  );

  const navigations = iterations * 2;
  const rates = result.map((durationMs) => (navigations * 60_000) / durationMs);
  const sortedRates = [...rates].sort((left, right) => left - right);
  const midpoint = Math.floor(sortedRates.length / 2);
  const median =
    sortedRates.length % 2 === 0
      ? (sortedRates[midpoint - 1] + sortedRates[midpoint]) / 2
      : sortedRates[midpoint];

  console.log(`Flitterbot E2E navigation benchmark: ${baseUrl.origin} (${actualVariant})`);
  console.log(`Chrome: ${await browser.version()}`);
  console.log(
    `${warmup} warmup cycles; ${samples} samples × ${iterations} cycles (${navigations} navigations/sample)`,
  );
  for (const [index, rate] of rates.entries()) {
    console.log(
      `Sample ${index + 1}: ${rate.toFixed(0)} navigations/min (${result[index].toFixed(1)} ms)`,
    );
  }
  console.log(`Median: ${median.toFixed(0)} navigations/min`);
} finally {
  await browser.close();
}
