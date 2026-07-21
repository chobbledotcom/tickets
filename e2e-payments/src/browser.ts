/**
 * Playwright browser lifecycle + thin form/navigation helpers over a real Page.
 * The app is driven exactly as a human would: load a page, fill fields by their
 * `name`, click a button by its visible text.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { browserLaunchOptions } from "#scripts/browser-options.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { repoRoot } from "./server.ts";

export interface BrowserSession {
  /** Absolute base the page navigates against (tunnel or local). */
  baseUrl: string;
  bodyText: () => Promise<string>;
  browser: Browser;
  check: (name: string, value?: string) => Promise<void>;
  clickButton: (text: string) => Promise<void>;
  clickLink: (text: string) => Promise<void>;
  /** Save a screenshot AND the page HTML to the artifacts dir. */
  dumpPage: (label: string) => Promise<void>;
  fill: (name: string, value: string) => Promise<void>;
  goto: (path: string) => Promise<void>;
  page: Page;
  screenshot: (label: string) => Promise<void>;
  select: (name: string, value: string) => Promise<void>;
  stop: () => Promise<void>;
  /** Robustly submit the form owning an arbitrary button locator. */
  submitLocator: (locator: Locator) => Promise<void>;
}

/** Read a link's href, failing loudly (with `whatFor`) when the link isn't
 *  there — so a missing nav target stops the run at the cause, not later. */
export const hrefOf = async (
  link: Locator,
  whatFor: string,
): Promise<string> => {
  const href = await link.getAttribute("href", {
    timeout: config.navTimeoutMs,
  });
  if (!href) throw new Error(whatFor);
  return href;
};

export const launchBrowser = async (
  baseUrl: string,
): Promise<BrowserSession> => {
  log(`Launching Chromium (headless=${config.headless})…`);
  const browser = await chromium.launch(
    browserLaunchOptions(config.headless, config.chromiumExecutable),
  );
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
    await page.screenshot({ fullPage: true, path: png }).catch(() => {});
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
  /** Force-click a control and wait for the resulting navigation to commit. */
  const clickAndWait = async (locator: Locator): Promise<void> => {
    await locator.click({ force: true, timeout: T });
    await page.waitForLoadState("domcontentloaded");
  };

  const robustSubmit = async (locator: Locator): Promise<void> => {
    await locator.waitFor({ state: "attached", timeout: T });
    const hasForm = await locator.evaluate(
      (el) => !!(el as HTMLButtonElement).form,
    );
    if (!hasForm) {
      await clickAndWait(locator);
    } else {
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        locator.evaluate((el) => (el as HTMLButtonElement).form?.submit()),
      ]);
    }
    await logWhere("submit");
  };

  // Set a form control by its `name`: log what's happening, then run the given
  // action on the first matching field. force: bypass the visible/enabled/stable
  // actionability wait — the app's form controls are styled/validated in ways
  // that make Playwright's default actionability hang in the CI Chromium. We
  // assert real outcomes elsewhere.
  const forceInput =
    (
      label: (name: string, value: string) => string,
      apply: (field: Locator, value: string) => Promise<unknown>,
    ) =>
    async (name: string, value: string): Promise<void> => {
      log(label(name, value));
      await apply(page.locator(sel(name)).first(), value);
    };

  return {
    baseUrl,
    bodyText: () => page.locator("body").innerText({ timeout: T }),
    browser,
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
        page.getByRole("button", { exact: false, name: text }).first(),
      );
    },
    clickLink: async (text) => {
      log(`  link "${text}"`);
      const link = page.getByRole("link", { exact: false, name: text }).first();
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
        await clickAndWait(link);
      }
      await logWhere(`link "${text}"`);
    },
    dumpPage,
    fill: forceInput(
      (name) => `  fill ${name}`,
      (field, value) => field.fill(value, { force: true, timeout: T }),
    ),
    goto: async (path) => {
      log(`  goto ${path}`);
      await page.goto(path, { waitUntil: "domcontentloaded" });
      await logWhere("goto");
    },
    page,
    screenshot: (label) => dumpPage(label),
    select: forceInput(
      (name, value) => `  select ${name}=${value}`,
      (field, value) => field.selectOption(value, { force: true, timeout: T }),
    ),
    stop: async () => {
      await browser.close();
    },
    submitLocator: (locator) => robustSubmit(locator),
  };
};

/** Minimal CSS attribute-value escape for form field names. */
const cssEscape = (v: string): string => v.replace(/"/g, '\\"');
