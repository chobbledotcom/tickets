import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser } from "playwright";
import { capturePreparedLayers } from "#scripts/screenshots/capture.ts";
import type { ScreenshotLayerName } from "#scripts/screenshots/layers.ts";
import {
  countLayerRgbPixels,
  countRgbPixels,
  expectLayersRecombine,
  expectOnlyLayerColor,
  launchScreenshotBrowser,
  layerStyle,
  withLayer,
  withPage,
} from "./screenshots-browser-helpers.ts";

describe("screenshot layer boundary browser contracts", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchScreenshotBrowser();
  });

  afterAll(async () => {
    await browser.close();
  });

  test("applies layer masks inside open shadow roots", async () => {
    await withPage(browser, '<div id="host"></div>', async (page) => {
      await page.locator("#host").evaluate((host) => {
        const root = host.attachShadow({ mode: "open" });
        root.innerHTML = `<style>
          button { background: rgb(255, 0, 0); color: rgb(0, 0, 255); }
        </style><button>Cart</button>`;
      });
      const shadowStyle = (layer: ScreenshotLayerName, property: string) =>
        withLayer(page, layer, () =>
          page.locator("#host").evaluate((host, propertyName) => {
            const button = host.shadowRoot?.querySelector("button");
            if (!button) throw new Error("Missing shadow button.");
            return getComputedStyle(button).getPropertyValue(propertyName);
          }, property),
        );

      expect(await shadowStyle("background", "visibility")).toBe("hidden");
      expect(await shadowStyle("controls", "-webkit-text-fill-color")).toBe(
        "rgba(0, 0, 0, 0)",
      );
      expect(await shadowStyle("text", "background-color")).toBe(
        "rgba(0, 0, 0, 0)",
      );
    });
  });

  test("keeps disclosure markers out of the text layer", async () => {
    await withPage(
      browser,
      "<style>summary::marker { color: rgb(255, 0, 0); }</style><details open><summary>More</summary></details>",
      async (page) => {
        const redPixels = countLayerRgbPixels(page, "summary", [255, 0, 0]);

        expect(await redPixels("controls")).toBeGreaterThan(0);
        expect(await redPixels("text")).toBe(0);
      },
    );
  });

  test("keeps SVG control labels only in the text layer", async () => {
    await withPage(
      browser,
      '<button><svg width="120" height="40"><text x="5" y="30" fill="rgb(0, 0, 255)" font-size="30">Words</text></svg></button>',
      async (page) => {
        const { layers } = await capturePreparedLayers(page);

        await expectOnlyLayerColor(layers, [0, 0, 255], "text");
      },
    );
  });

  test("keeps styled direct body text unchanged in one layer", async () => {
    await withPage(
      browser,
      `<style>body { color: rgb(0, 0, 255); font: 40px sans-serif; } span { color: rgb(255, 0, 0); }</style>
       Words`,
      async (page) => {
        const { layers } = await capturePreparedLayers(page);

        await expectOnlyLayerColor(layers, [0, 0, 255], "background");
        for (const layer of Object.values(layers)) {
          expect(await countRgbPixels(layer, [255, 0, 0])).toBe(0);
        }
      },
    );
  });

  test("keeps whole-paint control descendants with their control", async () => {
    await withPage(
      browser,
      `<style>
        button { background: rgb(255, 0, 0); border: 0; }
        button span { filter: brightness(2); }
      </style><button><span>Words</span></button>`,
      async (page) => {
        const { layers } = await capturePreparedLayers(page);

        await expectOnlyLayerColor(layers, [255, 0, 0], "background");
      },
    );
  });

  test("separates body-generated content", async () => {
    await withPage(
      browser,
      `<style>
        body::before { background: rgb(255, 0, 0); color: rgb(0, 0, 255); content: "Banner"; }
      </style>`,
      async (page) => {
        expect(
          await layerStyle(
            page,
            "background",
            "body",
            "-webkit-text-fill-color",
            "::before",
          ),
        ).toBe("rgba(0, 0, 0, 0)");
        expect(
          await layerStyle(page, "controls", "body", "visibility", "::before"),
        ).toBe("hidden");
        expect(
          await layerStyle(
            page,
            "text",
            "body",
            "background-color",
            "::before",
          ),
        ).toBe("rgba(0, 0, 0, 0)");
      },
    );
  });

  test("puts for-linked gallery labels in the controls layer", async () => {
    await withPage(
      browser,
      '<input id="gallery-1" type="radio"><label for="gallery-1">Thumbnail</label>',
      async (page) => {
        expect(
          await layerStyle(page, "background", "label", "visibility"),
        ).toBe("hidden");
        expect(await layerStyle(page, "controls", "label", "visibility")).toBe(
          "visible",
        );
      },
    );
  });

  test("does not reveal controls hidden by themselves or an ancestor", async () => {
    await withPage(
      browser,
      `<button style="visibility: hidden">Direct</button>
       <div style="visibility: hidden"><button>Inherited</button></div>`,
      async (page) => {
        const hiddenVisibility = (selector: string) =>
          withLayer(page, "controls", () =>
            page
              .locator(selector)
              .evaluate((element) => getComputedStyle(element).visibility),
          );

        expect(await hiddenVisibility("body > button")).toBe("hidden");
        expect(await hiddenVisibility("div button")).toBe("hidden");
        await expectLayersRecombine(page, "hidden controls");
      },
    );
  });

  test("keeps border images out of the text layer", async () => {
    await withPage(
      browser,
      `<style>
        div { border: 10px solid transparent; border-image: linear-gradient(rgb(255, 0, 0), rgb(255, 0, 0)) 1; height: 50px; width: 100px; }
      </style><div>Words</div>`,
      async (page) => {
        const { layers } = await capturePreparedLayers(page);

        await expectOnlyLayerColor(layers, [255, 0, 0], "background");
      },
    );
  });
});
