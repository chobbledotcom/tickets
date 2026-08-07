import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser } from "playwright";
import sharp from "sharp";
import { capturePreparedLayers } from "#scripts/screenshots/capture.ts";
import {
  countRgbPixels,
  expectBackgroundColorNotText,
  expectLayersRecombine,
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
      const layers = await capturePreparedLayers(page);

      await expectBackgroundColorNotText(layers, [255, 0, 0]);
      expect(await countRgbPixels(layers.controls, [255, 0, 0])).toBe(0);
    });
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

  test("keeps background-clipped lettering in the text layer", async () => {
    await withPage(
      browser,
      `<style>
        body { background: white; margin: 0; }
        p { background: rgb(255, 0, 0); background-clip: text; color: transparent; font: 80px sans-serif; margin: 0; }
      </style><p>Words</p>`,
      async (page) => {
        const layers = await capturePreparedLayers(page);

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
        const layers = await capturePreparedLayers(page);

        expect(await maxChannel(layers.background, 0)).toBe(
          await maxChannel(layers.controls, 1),
        );
        const beforeAdvance = await page.evaluate(() =>
          Reflect.get(globalThis, "ticks"),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(
          await page.evaluate(() => Reflect.get(globalThis, "ticks")),
        ).not.toBe(beforeAdvance);
      },
    );
  });
});
