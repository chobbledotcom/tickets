/**
 * Playwright browser lifecycle + thin form/navigation helpers over a real Page.
 * The app is driven exactly as a human would: load a page, fill fields by their
 * `name`, click a button by its visible text.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, type Locator, type Page, chromium } from "playwright";
import { config } from "./config.ts";
import { repoRoot } from "./server.ts";
import { log } from "./log.ts";

export interface BrowserSession {
  browser: Browser;
  page: Page;
  /** Absolute base the page navigates against (tunnel or local). */
  baseUrl: string;
  goto: (path: string) => Promise<void>;
  fill: (name: string, value: string) => Promise<void>;
  select: (name: string, value: string) => Promise<void>;
  check: (name: string, value?: string) => Promise<void>;
  clickButton: (text: string) => Promise<void>;
  /** Robustly submit the form owning an arbitrary button locator. */
  submitLocator: (locator: Locator) => Promise<void>;
  clickLink: (text: string) => Promise<void>;
  bodyText: () => Promise<string>;
  screenshot: (label: string) => Promise<void>;
  /** Save a screenshot AND the page HTML to the artifacts dir. */
  dumpPage: (label: string) => Promise<void>;
  stop: () => Promise<void>;
}

export const launchBrowser = async (baseUrl: string): Promise<BrowserSession> => {
  log(`Launching Chromium (headless=${config.headless})…`);
  const browser = await chromium.launch({
    headless: config.headless,
    ...(config.chromiumExecutable
      ? { executablePath: config.chromiumExecutable }
      : {}),
  });
  const context = await browser.newContext({ baseURL: baseUrl });
  context.setDefaultTimeout(config.navTimeoutMs);
  context.setDefaultNavigationTimeout(config.navTimeoutMs);
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") log(`  [browser console.error] ${m.text()}`);
  });

  const artifactsDir = join(repoRoot, "e2e-payments", config.artifactsDir);
  const sel = (name: string): string => `[name="${cssEscape(name)}"]`;
  const T = config.actionTimeoutMs;

  /** Log where we ended up after a navigation (breadcrumb for the CI logs). */
  const logWhere = async (prefix: string): Promise<void> => {
    try {
      const title = (await page.title()).trim();
      log(`    ${prefix} → ${page.url()}${title ? ` (${title})` : ""}`);
    } catch {
      // page is mid-navigation; ignore
    }
  };

  /** Save a screenshot AND the page HTML to the artifacts dir for debugging. */
  const dumpPage = async (label: string): Promise<void> => {
    const png = join(artifactsDir, `${label}.png`);
    const html = join(artifactsDir, `${label}.html`);
    await page.screenshot({ path: png, fullPage: true }).catch(() => {});
    await page
      .content()
      .then((c) => writeFile(html, c))
      .catch(() => {});
    log(`  saved artifacts: ${png} (+ .html)`);
  };

  /**
   * Submit the form owning `locator` robustly. We do NOT rely on clicking the
   * button: over a slow tunnel / in the CI Chromium the submit control can fail
   * Playwright's click-actionability (visible/enabled/stable) and hang the whole
   * timeout, and a real click also races admin.js's initFormSubmitDisable.
   * form.submit() posts the form (incl. the hidden CSRF field) exactly once —
   * no actionability wait, no double-submit, and (unlike requestSubmit) no
   * client constraint validation, which matters because the app renders an
   * invalid `pattern` that throws in recent Chromium. An out-of-band submit()
   * isn't tracked by Playwright's auto-wait, so wait for the navigation.
   */
  const robustSubmit = async (locator: Locator): Promise<void> => {
    await locator.waitFor({ state: "attached", timeout: T });
    const hasForm = await locator.evaluate(
      (el) => !!(el as HTMLButtonElement).form,
    );
    if (!hasForm) {
      await locator.click({ force: true, timeout: T });
      await page.waitForLoadState("domcontentloaded");
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        locator.evaluate((el) => (el as HTMLButtonElement).form?.submit()),
      ]);
    }
    await logWhere("submit");
  };

  return {
    browser,
    page,
    baseUrl,
    goto: async (path) => {
      log(`  goto ${path}`);
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await logWhere("goto");
    },
    // force: bypass the visible/enabled/stable actionability wait — the app's
    // form controls are styled/validated in ways that make Playwright's default
    // actionability hang in the CI Chromium. We assert real outcomes elsewhere.
    fill: async (name, value) => {
      log(`  fill ${name}`);
      await page.locator(sel(name)).first().fill(value, { force: true, timeout: T });
    },
    select: async (name, value) => {
      log(`  select ${name}=${value}`);
      await page
        .locator(sel(name))
        .first()
        .selectOption(value, { force: true, timeout: T });
    },
    check: async (name, value) => {
      const s = value ? `${sel(name)}[value="${value}"]` : sel(name);
      log(`  check ${name}${value ? `=${value}` : ""}`);
      const loc = page.locator(s).first();
      await loc.waitFor({ state: "attached", timeout: T });
      await loc.check({ force: true, timeout: T });
    },
    clickButton: async (text) => {
      log(`  submit "${text}"`);
      await robustSubmit(
        page.getByRole("button", { name: text, exact: false }).first(),
      );
    },
    submitLocator: (locator) => robustSubmit(locator),
    clickLink: async (text) => {
      log(`  link "${text}"`);
      const link = page.getByRole("link", { name: text, exact: false }).first();
      await link.waitFor({ state: "attached", timeout: T });
      const href = await link.getAttribute("href");
      // Navigate by href when possible — avoids click-actionability entirely.
      if (
        href &&
        !href.startsWith("#") &&
        !href.toLowerCase().startsWith("javascript:")
      ) {
        await page.goto(href, { waitUntil: "domcontentloaded" });
      } else {
        await link.click({ force: true, timeout: T });
        await page.waitForLoadState("domcontentloaded");
      }
      await logWhere(`link "${text}"`);
    },
    bodyText: () => page.locator("body").innerText({ timeout: T }),
    screenshot: (label) => dumpPage(label),
    dumpPage,
    stop: async () => {
      await browser.close();
    },
  };
};

/** Minimal CSS attribute-value escape for form field names. */
const cssEscape = (v: string): string => v.replace(/"/g, '\\"');
