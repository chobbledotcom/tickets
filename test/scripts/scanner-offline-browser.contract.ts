/**
 * Browser contract for the served scanner page's offline door: the page the
 * handler renders, running the built scanner bundle in Chromium. The direct
 * bundle suites drive the same client through the fixture harness; this
 * contract proves the surface a door worker actually loads. The page load
 * stores the door's keyed ticket cache, the door switch arms offline mode
 * and persists it across a reload, and the banner names each state the door
 * can be in. Every page error and error-grade console line fails the test,
 * so a bundle that cannot initialise (a missing export, for one) cannot pass
 * quietly.
 *
 * The stored cache is keyed: the digests come from the same door cache key
 * derivation the scan-cache endpoint answers with, never plain SHA-256.
 *
 * The local server answers only what the page needs: the scanner page at the
 * door's scan path, the door's scan-cache endpoint, and the built bundle. A
 * scan itself needs the camera, so the queue and sync mechanics stay with
 * the direct suites (test/ui/client/scanner-offline.test.ts).
 *
 * Runs under `deno task test:screenshot-contract` (Chromium required), never
 * in the main suite or the nightly harness.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import esbuild from "esbuild";
import type { Browser, Page } from "playwright";
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import { ensureMessageGroups, t } from "#i18n";
import { MESSAGE_GROUPS } from "#locales/manifest.ts";
import { doorCacheName, pageDoorCacheKey } from "#routes/admin/scan-cache.ts";
import { STATIC_JS_BUNDLES } from "#scripts/build-static-assets.ts";
import { SCANNER_JS_PATH } from "#shared/asset-paths.ts";
import { hmacHex, importHmacKey } from "#shared/sha256.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import {
  OWNER_SESSION,
  setupAdminPageTest,
} from "#test-utils/admin-page-test.ts";
import { launchScreenshotBrowser } from "./screenshots-browser-helpers.ts";

const SCAN_PATH = "/admin/groups/5/scan";
const CACHE_KEY = `scanner-tickets-${SCAN_PATH}`;
const MODE_KEY = "scanner-offline-mode";
const DOOR = doorCacheName("group", 5);
const TOKENS = ["tok-browser-1", "tok-browser-2"];

describe("the served scanner page's offline door", () => {
  let browser: Browser;
  let server: Deno.HttpServer;
  let baseUrl: string;
  let digests: string[];
  let firstDigest: string;

  beforeAll(async () => {
    await setupAdminPageTest();
    await ensureMessageGroups(MESSAGE_GROUPS);

    // The page key and the digests pair the way the scan-cache endpoint and
    // the served page pair them: one key derived from the door's name.
    const hmacKey = await importHmacKey(deriveDoorCacheKey(DOOR));
    digests = await Promise.all(TOKENS.map((token) => hmacHex(hmacKey, token)));
    const [named] = digests;
    if (!named) throw new Error("The contract built no ticket digests");
    firstDigest = named;
    const pageHtml = adminScannerPage(
      { name: "Ceilidh" },
      SCAN_PATH,
      OWNER_SESSION,
      [],
      false,
      pageDoorCacheKey(DOOR),
    );
    const bundle = await buildScannerBundle();
    // esbuild keeps a service child alive for later builds; the contract
    // builds once, so end it here or the suite leaks the child process.
    await esbuild.stop();

    server = Deno.serve(
      { hostname: "127.0.0.1", onListen: () => {}, port: 0 },
      (request) => {
        const { pathname } = new URL(request.url);
        if (request.method === "GET" && pathname === SCAN_PATH) {
          return new Response(pageHtml, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (request.method === "GET" && pathname === `${SCAN_PATH}-cache`) {
          return Response.json({ hashes: digests });
        }
        if (request.method === "GET" && pathname === SCANNER_JS_PATH) {
          return new Response(bundle, {
            headers: { "content-type": "text/javascript" },
          });
        }
        return new Response(null, { status: 404 });
      },
    );
    if (server.addr.transport !== "tcp") {
      throw new Error("Browser contract server did not open a TCP port");
    }
    baseUrl = `http://127.0.0.1:${server.addr.port}`;
    browser = await launchScreenshotBrowser();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.shutdown();
  });

  /** The scanner bundle built the standard way, in memory: the script the
   * served page loads, exactly as the static build writes it. */
  async function buildScannerBundle(): Promise<string> {
    const scanner = STATIC_JS_BUNDLES.find(
      (bundle) => bundle.label === "Scanner",
    );
    if (!scanner) {
      throw new Error("The static build carries no scanner bundle");
    }
    const result = await esbuild.build({ ...scanner.options, write: false });
    const [output] = result.outputFiles ?? [];
    if (!output) {
      throw new Error("The scanner bundle build produced no output");
    }
    return output.text;
  }

  /** One fresh context on the served page. Page errors and error-grade
   * console lines fail the test, so a bundle that cannot initialise cannot
   * pass quietly. */
  const withScannerPage = async <T>(
    run: (page: Page) => Promise<T>,
  ): Promise<T> => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const failures: string[] = [];
    page.on("pageerror", (error) =>
      failures.push(`page error: ${error.message}`),
    );
    page.on("console", (message) => {
      // Resource 404s — the stylesheet, the service worker this stub server
      // does not carry — are load noise, not init failures.
      if (
        message.type() === "error" &&
        !/Failed to load resource|bad HTTP response code/.test(message.text())
      ) {
        failures.push(`console error: ${message.text()}`);
      }
    });
    try {
      await page.goto(`${baseUrl}${SCAN_PATH}`, { waitUntil: "load" });
      const result = await run(page);
      expect(failures).toEqual([]);
      return result;
    } finally {
      await context.close();
    }
  };

  /** Waits for the boot's cache refresh to land and asserts the whole
   * stored value: the door's keyed digests and the store's own stamp. */
  const expectStoredCache = async (page: Page): Promise<void> => {
    await page
      .waitForFunction(
        ([key, wanted]) => {
          const raw = localStorage.getItem(key);
          if (raw === null) return false;
          try {
            const cache = JSON.parse(raw) as { hashes?: string[] };
            return Array.isArray(cache.hashes) && cache.hashes.includes(wanted);
          } catch {
            return false;
          }
        },
        [CACHE_KEY, firstDigest] as const,
      )
      .then(() => {});
    const raw = await page.evaluate(
      (key) => localStorage.getItem(key),
      CACHE_KEY,
    );
    expect(JSON.parse(String(raw))).toEqual({
      hashes: digests,
      storedAt: expect.any(Number),
    });
  };

  test("stores the door's keyed ticket cache when the page loads", async () => {
    await withScannerPage(async (page) => {
      // The page carries the door's cache key: the pairing the digests are
      // keyed under.
      expect(
        await page.getAttribute("#scanner-container", "data-door-cache-key"),
      ).toBe(pageDoorCacheKey(DOOR));

      await expectStoredCache(page);

      // The door boots with the switch off and the banner out of sight.
      expect(
        await page.getAttribute("#scanner-offline-toggle", "aria-pressed"),
      ).toBe("false");
      expect(
        await page.getAttribute("#scanner-offline-banner", "class"),
      ).toContain("hidden");
    });
  });

  test("arms the door switch, and the page remembers it when reloaded", async () => {
    await withScannerPage(async (page) => {
      const toggle = page.locator("#scanner-offline-toggle");
      await toggle.click();
      expect(await toggle.getAttribute("aria-pressed")).toBe("true");
      expect(
        await page.getAttribute("#scanner-offline-banner", "class"),
      ).not.toContain("hidden");
      expect(await page.textContent("#scanner-offline-banner-text")).toBe(
        t("admin.scanner.offline_banner_manual"),
      );
      expect(
        await page.evaluate((key) => localStorage.getItem(key), MODE_KEY),
      ).toBe("1");

      // The chosen mode survives a revisit: the reload restores the switch
      // and the banner from the store.
      await page.reload({ waitUntil: "load" });
      await page.waitForFunction(
        () =>
          document
            .getElementById("scanner-offline-toggle")
            ?.getAttribute("aria-pressed") === "true",
      );
      expect(await page.textContent("#scanner-offline-banner-text")).toBe(
        t("admin.scanner.offline_banner_manual"),
      );

      await toggle.click();
      expect(
        await page.evaluate((key) => localStorage.getItem(key), MODE_KEY),
      ).toBe(null);
      expect(
        await page.getAttribute("#scanner-offline-banner", "class"),
      ).toContain("hidden");
    });
  });

  test("re-words the banner when the connection drops and returns", async () => {
    await withScannerPage(async (page) => {
      await page.context().setOffline(true);
      await page.waitForFunction(
        ([auto]) =>
          document.getElementById("scanner-offline-banner-text")
            ?.textContent === auto,
        [t("admin.scanner.offline_banner_auto")] as const,
      );

      // The dropped connection's words stand offline, with or without the
      // switch: the switch's own words belong to a working connection.
      await page.locator("#scanner-offline-toggle").click();
      expect(await page.textContent("#scanner-offline-banner-text")).toBe(
        t("admin.scanner.offline_banner_auto"),
      );
      expect(
        await page.evaluate((key) => localStorage.getItem(key), MODE_KEY),
      ).toBe("1");
      await page.locator("#scanner-offline-toggle").click();
      expect(
        await page.evaluate((key) => localStorage.getItem(key), MODE_KEY),
      ).toBe(null);

      await page.context().setOffline(false);
      await page.waitForFunction(
        () =>
          document
            .getElementById("scanner-offline-banner")
            ?.className.includes("hidden") === true,
      );
    });
  });

  test("replaces a stored cache of the wrong shape on the next load", async () => {
    await withScannerPage(async (page) => {
      await page.evaluate(
        (key) => localStorage.setItem(key, "{oops"),
        CACHE_KEY,
      );
      await page.reload({ waitUntil: "load" });
      await expectStoredCache(page);
    });
  });
});
