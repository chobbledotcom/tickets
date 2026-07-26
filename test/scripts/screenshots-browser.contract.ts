import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import { type Browser, chromium } from "playwright";
import sharp from "sharp";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { capturePreparedPage } from "#scripts/screenshots/capture.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";

const launchBrowser = defineScreenshotBrowserLauncher(
  chromium,
  chromiumExecutable,
);

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
    } finally {
      await page.close();
    }
  });
});
