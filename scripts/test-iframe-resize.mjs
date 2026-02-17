/**
 * Browser test for iframe-resizer functionality on the embed demo page.
 *
 * Setup (run once):
 *   npm install playwright-core
 *   npx playwright install chromium
 *   npx playwright install-deps chromium
 *
 * Usage:
 *   node scripts/test-iframe-resize.mjs [url]
 *
 * Defaults to https://chobbledotcom.github.io/tickets/ if no URL given.
 * Exits with code 1 if iframe-resizer fails to resize the iframe.
 * Automatically detects HTTP(S)_PROXY environment variables.
 */

import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TARGET_URL =
  process.argv[2] || "https://chobbledotcom.github.io/tickets/";

/** Scan ~/.cache/ms-playwright for the newest chromium binary. */
function findChromium() {
  const home = process.env.HOME || "/root";
  const cacheDir = join(home, ".cache", "ms-playwright");
  if (!existsSync(cacheDir)) return null;

  const dirs = readdirSync(cacheDir)
    .filter((d) => d.startsWith("chromium-") && !d.includes("headless"))
    .sort()
    .reverse();

  for (const dir of dirs) {
    const bin = join(cacheDir, dir, "chrome-linux", "chrome");
    if (existsSync(bin)) return bin;
  }
  return null;
}

/** Parse HTTP(S)_PROXY env vars into Playwright proxy config. */
function parseProxy() {
  const raw = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return {
      server: `${url.protocol}//${url.hostname}:${url.port}`,
      username: url.username || undefined,
      password: url.password || undefined,
    };
  } catch {
    return null;
  }
}

(async () => {
  const executablePath = findChromium();
  if (!executablePath) {
    console.error(
      "Chromium not found. Install with: npx playwright install chromium",
    );
    process.exit(1);
  }

  console.log(`Chromium: ${executablePath}`);
  console.log(`Target:   ${TARGET_URL}`);

  const proxy = parseProxy();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    ...(proxy ? { proxy } : {}),
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();

  const consoleMsgs = [];
  page.on("console", (msg) =>
    consoleMsgs.push(`[${msg.type()}] ${msg.text()}`),
  );

  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  const failedRequests = [];
  page.on("requestfailed", (req) =>
    failedRequests.push(`${req.url()} - ${req.failure()?.errorText}`),
  );

  await page.goto(TARGET_URL, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  console.log("Page loaded, waiting for iframe-resizer to initialize...");
  await page.waitForTimeout(8000);

  const iframeElement = await page.$("iframe");
  if (!iframeElement) {
    console.error("FAIL: No iframe found on the page.");
    await browser.close();
    process.exit(1);
  }

  const bbox = await iframeElement.boundingBox();
  const attrs = await iframeElement.evaluate((el) => ({
    src: el.src,
    id: el.id,
    style: el.getAttribute("style"),
    offsetHeight: el.offsetHeight,
  }));

  console.log(`\niframe src:    ${attrs.src}`);
  console.log(`iframe id:     ${attrs.id}`);
  console.log(`iframe style:  ${attrs.style}`);
  console.log(`iframe height: ${bbox?.height ?? 0}px (bounding box)`);
  console.log(`               ${attrs.offsetHeight}px (offsetHeight)`);

  // Check iframe content dimensions via its frame
  const frames = page.frames();
  if (frames.length > 1) {
    try {
      const content = await frames[1].evaluate(() => ({
        bodyScrollHeight: document.body?.scrollHeight,
        documentHeight: document.documentElement?.scrollHeight,
      }));
      console.log(`content body:  ${content.bodyScrollHeight}px`);
      console.log(`content doc:   ${content.documentHeight}px`);
    } catch {
      console.log("content:       (cross-origin, cannot measure)");
    }
  }

  // Print any relevant console warnings/errors
  const problems = consoleMsgs.filter(
    (m) => m.includes("License") || m.includes("error") || m.includes("Error"),
  );
  if (problems.length > 0) {
    console.log("\n--- Browser console issues ---");
    for (const m of problems) console.log(`  ${m}`);
  }
  if (pageErrors.length > 0) {
    console.log("\n--- Page errors ---");
    for (const e of pageErrors) console.log(`  ${e}`);
  }
  if (failedRequests.length > 0) {
    console.log("\n--- Failed requests ---");
    for (const r of failedRequests) console.log(`  ${r}`);
  }

  // Verdict
  const height = bbox?.height ?? 0;
  console.log("\n--- VERDICT ---");
  let exitCode = 0;
  if (height < 100) {
    console.log(`FAIL: iframe is ${height}px tall - resizer is not working.`);
    exitCode = 1;
  } else if (height < 200) {
    console.log(`WARN: iframe is ${height}px tall - may not be fully resized.`);
    exitCode = 1;
  } else {
    console.log(
      `PASS: iframe is ${height}px tall - resizer appears to be working.`,
    );
  }

  if (pageErrors.some((e) => e.includes("License"))) {
    console.log("FAIL: iframe-resizer threw a license key error.");
    exitCode = 1;
  }

  await browser.close();
  process.exit(exitCode);
})();
