import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { type Browser, chromium, type Page } from "playwright";
import sharp from "sharp";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { capturePreparedPage } from "#scripts/screenshots/capture.ts";
import { isolateElementCss } from "#scripts/screenshots/checks.ts";
import {
  type ScreenshotLayerName,
  withScreenshotLayer,
} from "#scripts/screenshots/layers.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";

const launchBrowser = defineScreenshotBrowserLauncher(
  chromium,
  chromiumExecutable,
);

const layerStyle = (
  page: Page,
  layer: ScreenshotLayerName,
  selector: string,
  property: string,
  pseudo?: string,
): Promise<string> =>
  withScreenshotLayer(page, layer, () =>
    page
      .locator(selector)
      .evaluate(
        (element, options) =>
          getComputedStyle(element, options.pseudo).getPropertyValue(
            options.property,
          ),
        { property, pseudo },
      ),
  );

const withPage = async (
  browser: Browser,
  content: string,
  check: (page: Page) => Promise<void>,
): Promise<void> => {
  const page = await browser.newPage();
  try {
    await page.setContent(content);
    await check(page);
  } finally {
    await page.close();
  }
};

describe("screenshot browser contracts", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await launchBrowser();
  });

  afterAll(async () => {
    await browser.close();
  });

  test("waits for a delayed external SVG before declaring the page ready", async () => {
    let releaseSprite = () => {};
    const spriteReady = new Promise<void>((resolve) => {
      releaseSprite = resolve;
    });
    const server = Deno.serve(
      { hostname: "127.0.0.1", onListen: () => {}, port: 0 },
      async (request) => {
        if (new URL(request.url).pathname === "/icons.svg") {
          await spriteReady;
          return new Response(
            '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="save" viewBox="0 0 16 16"><path d="M0 0h16v16H0z"/></symbol></svg>',
            { headers: { "content-type": "image/svg+xml" } },
          );
        }
        return new Response(
          '<svg width="24" height="24"><use href="/icons.svg#save"></use></svg>',
          { headers: { "content-type": "text/html" } },
        );
      },
    );
    try {
      if (server.addr.transport !== "tcp") {
        throw new Error("Browser contract server did not open a TCP port");
      }
      const page = await browser.newPage();
      try {
        await page.goto(`http://127.0.0.1:${server.addr.port}`, {
          waitUntil: "domcontentloaded",
        });
        let ready = false;
        const readiness = (async () => {
          await waitForScreenshotPage(page);
          ready = true;
        })();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => resolve()),
                ),
              );
            }),
        );
        expect(ready).toBe(false);

        releaseSprite();
        await readiness;
        const icon = await page.locator("svg").screenshot();
        const stats = await sharp(icon).flatten({ background: "#fff" }).stats();
        expect(stats.channels.slice(0, 3).map(({ min }) => min)).toEqual([
          0, 0, 0,
        ]);
      } finally {
        await page.close();
      }
    } finally {
      releaseSprite();
      await server.shutdown();
      await server.finished;
    }
  });

  test("captures a tall element without changing its responsive viewport", async () => {
    const page = await browser.newPage({
      deviceScaleFactor: 2,
      viewport: { height: 844, width: 390 },
    });
    try {
      await page.setContent(`
        <style>
          * { box-sizing: border-box; }
          body { background: rgb(255, 255, 255); margin: 0; padding: 40px; }
          #target { height: 1000px; width: 200px; }
          @media (max-height: 844px) { #target { background: rgb(1, 2, 3); } }
          @media (min-height: 845px) { #target { background: rgb(250, 1, 1); } }
        </style>
        <div id="target"></div>
      `);

      const capture = await capturePreparedPage(page, "#target");
      const metadata = await sharp(capture.png).metadata();
      if (!metadata.width || !metadata.height) {
        throw new Error("The browser contract PNG has no dimensions");
      }
      const centerPixel = await sharp(capture.png)
        .extract({
          height: 1,
          left: Math.floor(metadata.width / 2),
          top: Math.floor(metadata.height / 2),
          width: 1,
        })
        .removeAlpha()
        .raw()
        .toBuffer();

      expect(page.viewportSize()).toEqual({ height: 844, width: 390 });
      expect(
        await page
          .locator("#target")
          .evaluate((element) => getComputedStyle(element).backgroundColor),
      ).toBe("rgb(1, 2, 3)");
      expect({ height: metadata.height, width: metadata.width }).toEqual({
        height: 2064,
        width: 464,
      });
      expect([...centerPixel]).toEqual([1, 2, 3]);
    } finally {
      await page.close();
    }
  });

  test("separates select chrome from its lettering", async () => {
    await withPage(
      browser,
      '<select style="background: rgb(255, 0, 0); color: rgb(0, 0, 255)"><option>Chosen value</option></select>',
      async (page) => {
        expect(await layerStyle(page, "controls", "select", "color")).toBe(
          "rgba(0, 0, 0, 0)",
        );
        expect(
          await layerStyle(page, "controls", "select", "background-color"),
        ).toBe("rgb(255, 0, 0)");
        expect(
          await layerStyle(page, "text", "select", "background-color"),
        ).toBe("rgba(0, 0, 0, 0)");
        expect(await layerStyle(page, "text", "select", "color")).toBe(
          "rgb(0, 0, 255)",
        );
      },
    );
  });

  test("removes pseudo-element chrome from the text layer", async () => {
    await withPage(
      browser,
      `<style>
        #decorated::before {
          background: rgb(255, 0, 0) !important;
          border: 2px solid rgb(0, 255, 0) !important;
          box-shadow: 0 0 2px rgb(0, 0, 255) !important;
          content: "";
        }
      </style><div id="decorated">Words</div>`,
      async (page) => {
        expect(
          await layerStyle(
            page,
            "text",
            "#decorated",
            "background-color",
            "::before",
          ),
        ).toBe("rgba(0, 0, 0, 0)");
        expect(
          await layerStyle(
            page,
            "text",
            "#decorated",
            "border-top-color",
            "::before",
          ),
        ).toBe("rgba(0, 0, 0, 0)");
        expect(
          await layerStyle(
            page,
            "text",
            "#decorated",
            "box-shadow",
            "::before",
          ),
        ).toBe("none");
      },
    );
  });

  test("puts btn links in the controls layer", async () => {
    await withPage(
      browser,
      '<a class="btn" href="/next">Continue</a>',
      async (page) => {
        expect(await layerStyle(page, "background", "a", "visibility")).toBe(
          "hidden",
        );
        expect(await layerStyle(page, "controls", "a", "visibility")).toBe(
          "visible",
        );
      },
    );
  });

  test("layer masks override ID-based element isolation", async () => {
    await withPage(
      browser,
      '<div id="target"><button>Save</button><img alt="Square" src="data:image/svg+xml,<svg xmlns=&quot;http://www.w3.org/2000/svg&quot;/>"></div>',
      async (page) => {
        await page.addStyleTag({ content: isolateElementCss("#target") });

        expect(
          await layerStyle(page, "background", "button", "visibility"),
        ).toBe("hidden");
        expect(await layerStyle(page, "text", "img", "visibility")).toBe(
          "hidden",
        );
      },
    );
  });

  test("keeps SVG text while removing its graphics from the text layer", async () => {
    await withPage(
      browser,
      '<svg><rect width="20" height="20"></rect><text x="2" y="12">Map</text></svg>',
      async (page) => {
        expect(await layerStyle(page, "text", "rect", "visibility")).toBe(
          "hidden",
        );
        expect(await layerStyle(page, "text", "text", "visibility")).toBe(
          "visible",
        );
        expect(await layerStyle(page, "background", "text", "visibility")).toBe(
          "hidden",
        );
      },
    );
  });
});
