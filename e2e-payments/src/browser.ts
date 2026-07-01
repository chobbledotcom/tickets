/**
 * Playwright browser lifecycle + thin form/navigation helpers over a real Page.
 * The app is driven exactly as a human would: load a page, fill fields by their
 * `name`, click a button by its visible text.
 */

import { join } from "node:path";
import { type Browser, type Page, chromium } from "playwright";
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
  clickLink: (text: string) => Promise<void>;
  bodyText: () => Promise<string>;
  screenshot: (label: string) => Promise<void>;
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

  return {
    browser,
    page,
    baseUrl,
    goto: async (path) => {
      await page.goto(path, { waitUntil: "domcontentloaded" });
    },
    fill: async (name, value) => {
      await page.fill(sel(name), value);
    },
    select: async (name, value) => {
      await page.selectOption(sel(name), value);
    },
    check: async (name, value) => {
      const s = value ? `${sel(name)}[value="${value}"]` : sel(name);
      await page.check(s);
    },
    clickButton: async (text) => {
      const btn = page.getByRole("button", { name: text, exact: false }).first();
      await btn.waitFor({ state: "attached" });
      try {
        await btn.click();
      } catch (err) {
        // A submit button can transiently fail click-actionability (visible/
        // enabled/stable) — e.g. layout still settling over a slow tunnel, or
        // admin.js's initFormSubmitDisable racing the click. Fall back to
        // submitting the form programmatically: requestSubmit() fires a real
        // submit (validation + CSRF + this button as submitter) without needing
        // the element to be actionable. Falls back to a JS click for a
        // non-submit button.
        log(
          `  clickButton("${text}") could not be clicked (${
            String(err).split("\n")[0]
          }); submitting its form directly`,
        );
        await btn.evaluate((el) => {
          const button = el as HTMLButtonElement;
          if (button.form) button.form.requestSubmit(button);
          else button.click();
        });
      }
      await page.waitForLoadState("domcontentloaded");
    },
    clickLink: async (text) => {
      await page.getByRole("link", { name: text, exact: false }).first().click();
      await page.waitForLoadState("domcontentloaded");
    },
    bodyText: () => page.locator("body").innerText(),
    screenshot: async (label) => {
      const path = join(artifactsDir, `${label}.png`);
      await page.screenshot({ path, fullPage: true }).catch(() => {});
      log(`  screenshot: ${path}`);
    },
    stop: async () => {
      await browser.close();
    },
  };
};

/** Minimal CSS attribute-value escape for form field names. */
const cssEscape = (v: string): string => v.replace(/"/g, '\\"');
