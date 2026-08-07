import { Buffer } from "node:buffer";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser } from "playwright";
import sharp from "sharp";
import { capturePreparedLayers } from "#scripts/screenshots/capture.ts";
import {
  addScreenshotStyle,
  withScreenshotLayer,
} from "#scripts/screenshots/layers.ts";
import {
  launchScreenshotBrowser,
  layerStyle,
  withPage,
} from "./screenshots-browser-helpers.ts";

describe("screenshot layer browser contracts", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchScreenshotBrowser();
  });

  afterAll(async () => {
    await browser.close();
  });

  test("keeps SVG control icons in the controls layer", async () => {
    await withPage(
      browser,
      '<button style="color: rgb(0, 0, 255)"><svg style="fill: currentColor"><use href="#save"></use></svg><span>Save</span></button>',
      async (page) => {
        expect(await layerStyle(page, "controls", "use", "fill")).toBe(
          "rgb(0, 0, 255)",
        );
        expect(
          await layerStyle(page, "controls", "span", "-webkit-text-fill-color"),
        ).toBe("rgba(0, 0, 0, 0)");
      },
    );
  });

  test("keeps generated control labels out of the controls layer", async () => {
    await withPage(
      browser,
      '<style>button::after { color: rgb(255, 0, 0); content: "3"; }</style><button>Cart</button>',
      async (page) => {
        expect(
          await layerStyle(
            page,
            "controls",
            "button",
            "-webkit-text-fill-color",
            "::after",
          ),
        ).toBe("rgba(0, 0, 0, 0)");
        expect(
          await layerStyle(page, "text", "button", "color", "::after"),
        ).toBe("rgb(255, 0, 0)");
      },
    );
  });

  test("keeps nested generated control labels out of the controls layer", async () => {
    await withPage(
      browser,
      `<style>
        button span::after {
          content: "3";
          -webkit-text-fill-color: rgb(255, 0, 0);
        }
      </style><button><span>Cart</span></button>`,
      async (page) => {
        expect(
          await layerStyle(
            page,
            "controls",
            "button span",
            "-webkit-text-fill-color",
            "::after",
          ),
        ).toBe("rgba(0, 0, 0, 0)");
      },
    );
  });

  test("keeps foreignObject labels in the text layer", async () => {
    await withPage(
      browser,
      '<svg><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Label</div></foreignObject></svg>',
      async (page) => {
        expect(
          await layerStyle(page, "text", "foreignObject", "visibility"),
        ).toBe("visible");
        expect(
          await layerStyle(page, "text", "foreignObject div", "color"),
        ).not.toBe("rgba(0, 0, 0, 0)");
      },
    );
  });

  test("keeps embedded documents out of the text layer", async () => {
    await withPage(
      browser,
      '<iframe srcdoc="<p>Embedded words</p>"></iframe>',
      async (page) => {
        expect(await layerStyle(page, "text", "iframe", "visibility")).toBe(
          "hidden",
        );
        expect(
          await layerStyle(page, "background", "iframe", "visibility"),
        ).toBe("visible");
      },
    );
  });

  test("puts disabled btn spans in the controls layer", async () => {
    await withPage(
      browser,
      '<span class="btn btn--disabled">Unavailable</span>',
      async (page) => {
        expect(await layerStyle(page, "background", ".btn", "visibility")).toBe(
          "hidden",
        );
        expect(await layerStyle(page, "controls", ".btn", "visibility")).toBe(
          "visible",
        );
      },
    );
  });

  test("applies layer masks without bypassing page CSP", async () => {
    await withPage(
      browser,
      `<meta http-equiv="Content-Security-Policy" content="style-src 'self'">
       <p style="color: rgb(255, 0, 0)">Words</p>`,
      async (page) => {
        expect(await layerStyle(page, "text", "p", "color")).not.toBe(
          "rgb(255, 0, 0)",
        );
        expect(
          await layerStyle(page, "background", "p", "-webkit-text-fill-color"),
        ).toBe("rgba(0, 0, 0, 0)");
      },
    );
  });

  test("puts label-backed and disclosure widgets in the controls layer", async () => {
    await withPage(
      browser,
      `<label class="order-card"><input type="checkbox">Ticket</label>
       <label class="row-select"><input type="checkbox">Row</label>
       <details><summary>More</summary><p>Details</p></details>`,
      async (page) => {
        for (const selector of [".order-card", ".row-select", "summary"]) {
          expect(
            await layerStyle(page, "background", selector, "visibility"),
          ).toBe("hidden");
          expect(
            await layerStyle(page, "controls", selector, "visibility"),
          ).toBe("visible");
        }
      },
    );
  });

  test("puts combobox options in the controls layer", async () => {
    await withPage(
      browser,
      '<div role="option">Matching attendee</div>',
      async (page) => {
        expect(
          await layerStyle(page, "background", '[role="option"]', "visibility"),
        ).toBe("hidden");
        expect(
          await layerStyle(page, "controls", '[role="option"]', "visibility"),
        ).toBe("visible");
      },
    );
  });

  test("preserves native control geometry in the text layer", async () => {
    await withPage(
      browser,
      '<label><input id="check" type="checkbox"><span>Remember me</span></label>',
      async (page) => {
        const geometry = () =>
          page.locator("label").evaluate((label) => {
            const control = label.querySelector("input");
            const words = label.querySelector("span");
            if (!control || !words) throw new Error("Missing test control.");
            const controlBox = control.getBoundingClientRect();
            const wordsBox = words.getBoundingClientRect();
            return {
              control: [
                controlBox.x,
                controlBox.y,
                controlBox.width,
                controlBox.height,
              ],
              words: [wordsBox.x, wordsBox.y, wordsBox.width, wordsBox.height],
            };
          });
        const normal = await geometry();

        expect(await withScreenshotLayer("text")(page, geometry)).toEqual(
          normal,
        );
      },
    );
  });

  test("keeps modal backdrops out of the text layer", async () => {
    await withPage(
      browser,
      "<style>dialog::backdrop { background: rgb(1, 2, 3); }</style><dialog>Words</dialog>",
      async (page) => {
        await page
          .locator("dialog")
          .evaluate((dialog) => (dialog as HTMLDialogElement).showModal());
        expect(
          await layerStyle(
            page,
            "text",
            "dialog",
            "background-color",
            "::backdrop",
          ),
        ).toBe("rgba(0, 0, 0, 0)");
        expect(
          await layerStyle(
            page,
            "background",
            "dialog",
            "background-color",
            "::backdrop",
          ),
        ).toBe("rgb(1, 2, 3)");
      },
    );
  });

  test("keeps date picker indicator pixels out of the text layer", async () => {
    await withPage(
      browser,
      `<style>
        input { background: transparent; border: 0; color: transparent; height: 30px; width: 120px; }
        input::-webkit-calendar-picker-indicator { background: rgb(255, 0, 0); opacity: 1; }
      </style><input type="date">`,
      async (page) => {
        const redPixels = async (layer: "controls" | "text") => {
          const png = await withScreenshotLayer(layer)(page, () =>
            page.locator("input").screenshot({ omitBackground: true }),
          );
          const { data, info } = await sharp(png)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
          return data.reduce(
            (count, red, index) =>
              index % info.channels === 0 &&
              red === 255 &&
              data[index + 1] === 0 &&
              data[index + 2] === 0
                ? count + 1
                : count,
            0,
          );
        };

        expect(await redPixels("controls")).toBeGreaterThan(0);
        expect(await redPixels("text")).toBe(0);
      },
    );
  });

  test("preserves imports in screenshot CSS", async () => {
    await withPage(browser, "<p>Imported</p>", async (page) => {
      const removeStyle = await addScreenshotStyle(
        page,
        '@import url("data:text/css,p%7Bcolor%3Argb(1%2C2%2C3)%7D");',
      );
      try {
        expect(await layerStyle(page, "text", "p", "color")).toBe(
          "rgb(1, 2, 3)",
        );
      } finally {
        await removeStyle();
      }
    });
  });

  test("adds screenshot CSS on a page with a URL fragment", async () => {
    await withPage(browser, "<p>Styled</p>", async (page) => {
      await page.goto(`${page.url()}#terms`);

      const removeStyle = await addScreenshotStyle(
        page,
        "p { color: rgb(1, 2, 3); }",
      );
      try {
        expect(await layerStyle(page, "text", "p", "color")).toBe(
          "rgb(1, 2, 3)",
        );
      } finally {
        await removeStyle();
      }
    });
  });

  test("layer masks outrank existing important cascade layers", async () => {
    await withPage(
      browser,
      `<style>@layer __screenshot_layer__; @layer components {
        p { -webkit-text-fill-color: rgb(255, 0, 0) !important; }
      }</style><p>Words</p>`,
      async (page) => {
        expect(
          await layerStyle(page, "background", "p", "-webkit-text-fill-color"),
        ).toBe("rgba(0, 0, 0, 0)");
      },
    );
  });

  test("recombines an opacity group exactly", async () => {
    await withPage(
      browser,
      `<style>
        body { background: white; margin: 0; }
        #group { background: red; color: blue; height: 40px; opacity: 0.5; width: 100px; }
      </style><div id="group">Words</div>`,
      async (page) => {
        const normal = await page.screenshot({ type: "png" });
        const layers = await capturePreparedLayers(page);
        const combined = await sharp(layers.background)
          .composite([
            { input: Buffer.from(layers.controls) },
            { input: Buffer.from(layers.text) },
          ])
          .ensureAlpha()
          .raw()
          .toBuffer();
        expect(combined).toEqual(
          await sharp(normal).ensureAlpha().raw().toBuffer(),
        );
      },
    );
  });
});
