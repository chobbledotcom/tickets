import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser } from "playwright";
import { addScreenshotStyle } from "#scripts/screenshots/layers.ts";
import {
  countLayerRgbPixels,
  expectLayersRecombine,
  launchScreenshotBrowser,
  withPage,
} from "./screenshots-browser-helpers.ts";

describe("screenshot layer edge browser contracts", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchScreenshotBrowser();
  });

  afterAll(async () => {
    await browser.close();
  });

  test("resolves screenshot CSS assets from the custom stylesheet path", async () => {
    await withPage(browser, "<p>Initial</p>", async (page) => {
      const nestedUrl = new URL("/setup/", page.url()).toString();
      const importedUrl = new URL("/theme.css", page.url()).toString();
      await page.route(nestedUrl, (route) =>
        route.fulfill({ body: "<p>Imported</p>", contentType: "text/html" }),
      );
      await page.route(importedUrl, (route) =>
        route.fulfill({
          body: "p { color: rgb(1, 2, 3); }",
          contentType: "text/css",
        }),
      );
      await page.goto(nestedUrl);

      const removeStyle = await addScreenshotStyle(
        page,
        '@import "./theme.css";',
      );
      try {
        expect(
          await page
            .locator("p")
            .evaluate((element) =>
              getComputedStyle(element).getPropertyValue("color"),
            ),
        ).toBe("rgb(1, 2, 3)");
      } finally {
        await removeStyle();
      }
    });
  });

  test("keeps file selector button chrome out of the text layer", async () => {
    await withPage(
      browser,
      `<style>
        input { color: rgb(0, 0, 255); }
        input::file-selector-button { background: rgb(255, 0, 0); border: 0; }
      </style><input type="file">`,
      async (page) => {
        const redPixels = countLayerRgbPixels(page, "input", [255, 0, 0]);

        expect(await redPixels("controls")).toBeGreaterThan(0);
        expect(await redPixels("text")).toBe(0);
      },
    );
  });

  for (const root of ["body", "html"] as const) {
    test(`recombines ${root} opacity exactly`, async () => {
      await withPage(
        browser,
        `<style>
          ${root} { opacity: 0.5; }
          body { background: red; color: blue; margin: 0; }
        </style><p>Words</p>`,
        (page) => expectLayersRecombine(page, `${root} opacity`),
      );
    });
  }

  test("recombines a filter group exactly", async () => {
    await withPage(
      browser,
      `<style>
        body { background: white; margin: 0; }
        button { background: rgb(200, 0, 0); color: rgb(100, 0, 0); filter: brightness(2); }
      </style><button>Words</button>`,
      (page) => expectLayersRecombine(page, "filter group"),
    );
  });
});
