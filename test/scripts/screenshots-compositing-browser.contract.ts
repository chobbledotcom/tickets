import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser, Page } from "playwright";
import sharp from "sharp";
import { capturePreparedLayers } from "#scripts/screenshots/capture.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";
import {
  countRgbPixels,
  expectLayersRecombine,
  expectOnlyBackgroundColor,
  launchScreenshotBrowser,
  withPage,
} from "./screenshots-browser-helpers.ts";

const maxChannel = async (
  png: Uint8Array,
  channel: number,
): Promise<number> => {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data.reduce(
    (highest, value, index) =>
      index % info.channels === channel ? Math.max(highest, value) : highest,
    0,
  );
};

const expectShadowButtonRecombines = async (
  page: Page,
  label: string,
): Promise<void> => {
  await page.locator("#host").evaluate((host) => {
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      '<button style="background: red; color: blue">Words</button>';
  });
  await expectLayersRecombine(page, label);
};

describe("screenshot layer compositing browser contracts", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchScreenshotBrowser();
  });

  afterAll(async () => {
    await browser.close();
  });

  test("recombines whole-paint groups inside nested shadow roots", async () => {
    await withPage(browser, '<div id="host"></div>', async (page) => {
      await page.locator("#host").evaluate((host) => {
        const outer = host.attachShadow({ mode: "open" });
        outer.innerHTML = '<div id="nested"></div>';
        const nested = outer.querySelector("#nested");
        if (!nested) throw new Error("Missing nested shadow host.");
        const inner = nested.attachShadow({ mode: "open" });
        inner.innerHTML = `<style>
          button { background: rgb(200, 0, 0); color: rgb(100, 0, 0); filter: brightness(2); }
        </style><button>Words</button>`;
      });
      const { layers } = await capturePreparedLayers(page);

      await expectOnlyBackgroundColor(layers, [255, 0, 0]);
    });
  });

  test("recombines a whole-paint shadow host", async () => {
    await withPage(
      browser,
      '<div id="host" style="opacity: 0.5"></div>',
      (page) => expectShadowButtonRecombines(page, "shadow host opacity group"),
    );
  });

  test("recombines a shadow host inside a whole-paint ancestor", async () => {
    await withPage(
      browser,
      '<div style="opacity: 0.5"><div id="host"></div></div>',
      (page) =>
        expectShadowButtonRecombines(
          page,
          "shadow host ancestor opacity group",
        ),
    );
  });

  test("recombines generated opacity groups", async () => {
    await withPage(
      browser,
      `<style>
        body { background: white; margin: 0; }
        div::before { background: red; color: blue; content: "Badge"; opacity: 0.5; }
      </style><div>Words</div>`,
      (page) => expectLayersRecombine(page, "generated opacity group"),
    );
  });

  test("recombines mix-blend-mode groups", async () => {
    await withPage(
      browser,
      `<style>
        body { background: rgb(50, 100, 150); margin: 0; }
        div { background: rgb(200, 100, 50); color: white; mix-blend-mode: multiply; }
      </style><div>Words</div>`,
      (page) => expectLayersRecombine(page, "blend group"),
    );
  });

  test("recombines masked paint groups", async () => {
    await withPage(
      browser,
      `<style>
        body { background: white; margin: 0; }
        div { background: red; color: blue; font: 80px sans-serif; mask-image: linear-gradient(to right, transparent, black); }
      </style><div>Words</div>`,
      (page) => expectLayersRecombine(page, "masked paint group"),
    );
  });

  test("separates generated content owned by the html root", async () => {
    await withPage(
      browser,
      `<style>
        html::before { background: red; color: blue; content: "Banner"; }
      </style>`,
      async (page) => {
        const { layers } = await capturePreparedLayers(page);

        await expectOnlyBackgroundColor(layers, [255, 0, 0]);
        expect(await countRgbPixels(layers.controls, [0, 0, 255])).toBe(0);
        expect(await countRgbPixels(layers.background, [0, 0, 255])).toBe(0);
        expect(await countRgbPixels(layers.text, [0, 0, 255])).toBeGreaterThan(
          0,
        );
      },
    );
  });

  test("uses one animation state for normal and layered captures", async () => {
    await withPage(
      browser,
      `<style>
        @keyframes pulse { from { background: red; } to { background: blue; } }
        button { animation: pulse 10s infinite alternate; border: 0; height: 80px; width: 160px; }
      </style><button>Words</button>`,
      async (page) => {
        const { layers, png } = await capturePreparedLayers(page);
        const pixelAt = (image: Uint8Array) =>
          sharp(image)
            .extract({ height: 1, left: 20, top: 20, width: 1 })
            .removeAlpha()
            .raw()
            .toBuffer();

        expect(await pixelAt(layers.controls)).toEqual(await pixelAt(png));
      },
    );
  });

  test("waits for pending page requests before capture", async () => {
    await withPage(
      browser,
      '<output id="result">Waiting</output>',
      async (page) => {
        const requestStarted = Promise.withResolvers<void>();
        const releaseResponse = Promise.withResolvers<void>();
        await page.route("https://screenshots.test/value", async (route) => {
          requestStarted.resolve();
          await releaseResponse.promise;
          await route.fulfill({ body: "Ready" });
        });
        await page.evaluate(() => {
          void (async () => {
            const response = await fetch("/value");
            const value = await response.text();
            const output = document.querySelector("output");
            if (!output) throw new Error("Missing test output.");
            output.textContent = value;
          })();
        });
        await requestStarted.promise;

        // The held request proves network idle, not a coincidental paint wait,
        // controls readiness.
        let ready = false;
        const readiness = (async () => {
          await waitForScreenshotPage(page);
          ready = true;
        })();
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        expect(ready).toBe(false);
        releaseResponse.resolve();

        await readiness;

        expect(await page.locator("#result").textContent()).toBe("Ready");
      },
    );
  });

  test("keeps background-clipped lettering in the text layer", async () => {
    await withPage(
      browser,
      `<style>
        body { background: white; margin: 0; }
        p { background: rgb(255, 0, 0); background-clip: text; color: transparent; font: 80px sans-serif; margin: 0; }
      </style><p>Words</p>`,
      async (page) => {
        const { layers } = await capturePreparedLayers(page);

        expect(await countRgbPixels(layers.background, [255, 0, 0])).toBe(0);
        expect(await countRgbPixels(layers.text, [255, 0, 0])).toBeGreaterThan(
          0,
        );
      },
    );
  });

  test("keeps timers still for the complete layer sequence", async () => {
    await withPage(
      browser,
      `<button aria-label="Changing control" style="border: 0; height: 80px; margin: 0; width: 160px"></button><script>
        globalThis.ticks = 20;
        const update = () => {
          globalThis.ticks = globalThis.ticks === 219 ? 20 : globalThis.ticks + 1;
          const button = document.querySelector("button");
          document.body.style.background = "rgb(" + globalThis.ticks + ", 0, 0)";
          button.style.background = "rgb(0, " + globalThis.ticks + ", 0)";
        };
        update();
        setInterval(update, 1);
      </script>`,
      async (page) => {
        const { layers } = await capturePreparedLayers(page);

        expect(await maxChannel(layers.background, 0)).toBe(
          await maxChannel(layers.controls, 1),
        );
        const beforeAdvance = await page.evaluate(() =>
          Reflect.get(globalThis, "ticks"),
        );
        await page.waitForFunction(
          (previous) => Reflect.get(globalThis, "ticks") !== previous,
          beforeAdvance,
        );
        expect(
          await page.evaluate(() => Reflect.get(globalThis, "ticks")),
        ).not.toBe(beforeAdvance);
      },
    );
  });
});
