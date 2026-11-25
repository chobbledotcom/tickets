import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import type { Browser } from "playwright";
import sharp from "sharp";
import { withStrictBrowserTimeouts } from "#scripts/browser-options.ts";
import { packageGuideAnimation } from "#scripts/guides/package.ts";
import { bundleGuideRenderer } from "#scripts/guides/render/bundle.ts";
import {
  defineLoopbackServer,
  type LoopbackServer,
} from "#scripts/loopback-server.ts";
import { launchScreenshotBrowser } from "../screenshots-browser-helpers.ts";
import { writeGuideSession } from "./session-fixture.ts";

const VIEWPORT = { height: 720, width: 1280 };

const contentTypeFor = (path: string): string => {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".json")) return "application/json; charset=utf-8";
  if (path.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
};

const centreRed = async (png: Uint8Array): Promise<number> => {
  const { data, info } = await sharp(png)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const x = Math.floor(info.width / 2);
  const y = Math.floor(info.height / 2);
  return data[(y * info.width + x) * info.channels]!;
};

describe("guide player browser contract", () => {
  let browser: Browser;
  let root: string;
  let server: LoopbackServer;

  beforeAll(async () => {
    root = await Deno.makeTempDir({ prefix: "guide-player-" });
    const session = join(root, "session");
    await writeGuideSession(session, 8, 500);
    await packageGuideAnimation(session, join(root, "create-a-listing"));
    await Deno.writeTextFile(
      join(root, "player.js"),
      await bundleGuideRenderer(),
    );
    server = defineLoopbackServer(async (request) => {
      const url = new URL(request.url);
      const path = url.pathname === "/" ? "/index.html" : url.pathname;
      try {
        const bytes = await Deno.readFile(join(root, path));
        return new Response(Uint8Array.from(bytes).buffer, {
          headers: { "content-type": contentTypeFor(path) },
        });
      } catch {
        // A missing file is a 404 for this test server.
        return new Response("Not found", { status: 404 });
      }
    })();
    browser = await launchScreenshotBrowser();
  });

  afterAll(async () => {
    await browser.close();
    await server.close();
    await Deno.remove(root, { recursive: true });
  });

  test("plays the recorded frames without an MP4", async () => {
    const page = await browser.newPage({ viewport: VIEWPORT });
    withStrictBrowserTimeouts(page);
    try {
      await page.goto(`${server.baseUrl}/create-a-listing/index.html`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForFunction(
        () => Reflect.get(globalThis, "rendererReady") === true,
      );

      await page.waitForTimeout(250);
      const first = await centreRed(await page.screenshot({ type: "png" }));
      await page.waitForTimeout(1100);
      const second = await centreRed(await page.screenshot({ type: "png" }));
      await page.waitForTimeout(2400);
      const looped = await centreRed(await page.screenshot({ type: "png" }));

      expect(first).toBeLessThan(20);
      expect(second).toBeGreaterThan(40);
      expect(looped).toBeLessThan(20);
    } finally {
      await page.close();
    }
  });
});
