/**
 * Playwright browser lifecycle + thin form/navigation helpers over a real Page.
 *
 * One browser process may hold any number of independent sessions (an owner
 * context, a cookie-free visitor context, a second signed-in owner window);
 * a single session is just the array-of-one case. The app is driven the way a
 * person drives it: fill fields by their accessible name, click buttons and
 * links by their visible text, and submit through the visible submit control —
 * never force, never `form.submit()`, so actionability, browser validation and
 * the app's own event handlers all run.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Browser, chromium, type Locator, type Page } from "playwright";
import { browserLaunchOptions } from "#scripts/browser-options.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";
import { artifactsRoot } from "./server.ts";
import { pollUntil } from "./util.ts";

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
  /** Click an arbitrary control and wait for the navigation it causes. */
  submitLocator: (locator: Locator) => Promise<void>;
  /** Type into a visible rich-text editing surface, like the listing
   * description's markdown editor (whose backing textarea is hidden). */
  typeInto: (selector: string, text: string) => Promise<void>;
}

/**
 * Fill the named boxes, then press the named button. Nearly every form this
 * suite submits is that shape, so the caller names the boxes and the button
 * rather than writing the steps out.
 */
export const fillAndSubmit = async (
  session: BrowserSession,
  boxes: Record<string, string>,
  button: string,
): Promise<void> => {
  for (const [name, value] of Object.entries(boxes)) {
    await session.fill(name, value);
  }
  await session.clickButton(button);
};

export interface AppBrowser {
  baseUrl: string;
  browser: Browser;
  /** A fresh independent session — its own cookies — against the app. */
  session: (artifactPrefix: string) => Promise<BrowserSession>;
  stop: () => Promise<void>;
}

/** Require the page body to carry this answer — one text, one pattern, or
 * any of several texts — saving the page before a concise failure. */
export const requirePageText = async (
  session: BrowserSession,
  expected: string | RegExp | readonly string[],
  artifact: string,
  message: string,
): Promise<void> => {
  const body = await session.bodyText();
  const carries =
    typeof expected === "string"
      ? body.includes(expected)
      : expected instanceof RegExp
        ? expected.test(body)
        : expected.some((answer) => body.includes(answer));
  if (carries) return;
  await session.dumpPage(artifact);
  throw new Error(`${message}\n${body.slice(0, 800)}`);
};

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

/** Whether the control can honestly be acted on at all. */
const interactable = async (locator: Locator): Promise<boolean> =>
  (await locator.isVisible()) && (await locator.isEnabled());

/** The page-side shape the click witness stamps onto a control. */
type Witnessed = {
  __e2eClickSeen?: boolean;
  addEventListener: (
    type: string,
    listener: () => void,
    options: { capture: boolean; once: boolean },
  ) => void;
};

/** Arm a page-side click witness on the control. The returned question is
 * whether the click may have dispatched — and a witness that cannot answer
 * (the element or its document is already gone, which navigation after a
 * dispatched submission causes) says yes, never "safe to replay". */
const armClickWitness = async (
  control: Locator,
): Promise<() => Promise<boolean>> => {
  const armed = await control
    .evaluate((element) => {
      const witnessed = element as unknown as Witnessed;
      witnessed.__e2eClickSeen = false;
      witnessed.addEventListener(
        "click",
        () => {
          witnessed.__e2eClickSeen = true;
        },
        { capture: true, once: true },
      );
    })
    .then(() => true)
    .catch(() => false);
  return () =>
    armed
      ? control
          .evaluate(
            (element) =>
              (element as unknown as Witnessed).__e2eClickSeen !== false,
          )
          .catch(() => true)
      : Promise.resolve(true);
};

/** Arm the click witness and return the attempt that runs an ordinary action
 * under it: true when the action finished, false only for the one
 * replay-safe failure — the witness proves the click never dispatched and
 * the control is still interactable. Every other failure rethrows: replaying
 * a dispatched submission would act twice, and a second POST on a live
 * refund form moves real money. */
const armWitnessedAttempt = async (
  control: Locator,
): Promise<(ordinary: () => Promise<void>) => Promise<boolean>> => {
  const mayHaveDispatched = await armClickWitness(control);
  return async (ordinary) => {
    try {
      await ordinary();
      return true;
    } catch (error) {
      if (await mayHaveDispatched()) throw error;
      if (!(await interactable(control))) throw error;
      return false;
    }
  };
};

export const launchAppBrowser = async (
  baseUrl: string,
): Promise<AppBrowser> => {
  log(`Launching Chromium (headless=${config.headless})…`);
  const browser = await chromium.launch(
    browserLaunchOptions(config.headless, config.chromiumExecutable),
  );

  const session = async (artifactPrefix: string): Promise<BrowserSession> => {
    const context = await browser.newContext({ baseURL: baseUrl });
    context.setDefaultTimeout(config.navTimeoutMs);
    context.setDefaultNavigationTimeout(config.navTimeoutMs);
    const page = await context.newPage();
    page.on("console", (m) => {
      if (m.type() === "error") log(`  [browser console.error] ${m.text()}`);
    });

    const T = config.actionTimeoutMs;

    /** The first form field with this name on the page. */
    const thisField = (name: string): Locator =>
      page.locator(`[name="${cssEscape(name)}"]`).first();

    /** Log where we ended up after a navigation (breadcrumb for the CI logs). */
    const logWhere = async (prefix: string): Promise<void> => {
      try {
        const title = (await page.title()).trim();
        log(`    ${prefix} → ${page.url()}${title ? ` (${title})` : ""}`);
      } catch {
        // page is mid-navigation; ignore
      }
    };

    /** Save a screenshot AND the page HTML for debugging; the artifact prefix
     * (the case id) keeps scenarios from overwriting each other's evidence. */
    const dumpPage = async (label: string): Promise<void> => {
      const png = join(artifactsRoot, `${artifactPrefix}-${label}.png`);
      const html = join(artifactsRoot, `${artifactPrefix}-${label}.html`);
      await page.screenshot({ fullPage: true, path: png }).catch(() => {});
      await page
        .content()
        .then((c) => writeFile(html, c))
        .catch(() => {});
      log(`  saved artifacts: ${png} (+ .html)`);
    };

    /**
     * Whether this page's renderer is currently producing animation frames.
     * Some headless Chromium builds stop scheduling compositor frames once a
     * form POST has happened; the page stays fully functional but Playwright's
     * pointer-action stability wait then hangs past its own timeout. Probing
     * once per navigation lets interaction skip the doomed ordinary attempt
     * instead of burning its whole timeout on every action.
     */
    let framesLive: Promise<boolean> | null = null;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) framesLive = null;
    });
    const framesAreLive = (): Promise<boolean> => {
      framesLive ??= page.evaluate(
        () =>
          new Promise<boolean>((resolve) => {
            const frames = globalThis as {
              requestAnimationFrame?: (callback: () => void) => number;
            };
            frames.requestAnimationFrame?.(() => resolve(true));
            setTimeout(() => resolve(false), 1_200);
          }),
      );
      return framesLive;
    };

    /** Act on a control through the page's own DOM APIs: `requestSubmit` for
     * a form's submit control (which runs browser validation and the app's
     * submit handlers), a scripted click for anything else. Typed without the
     * DOM library so both compile configs can check this module. */
    const actThroughDom = async (locator: Locator): Promise<void> => {
      await locator.evaluate((element) => {
        const control = element as {
          click: () => void;
          form?: { requestSubmit: (submitter?: unknown) => void } | null;
          type?: string;
        };
        if (control.type === "submit" && control.form) {
          control.form.requestSubmit(control);
          return;
        }
        control.click();
      });
    };

    /** Act through the page's own DOM APIs (see actThroughDom), but only
     * for a control that is genuinely visible and enabled. */
    const throughDomIfInteractable = async (
      control: Locator,
    ): Promise<void> => {
      if (!(await interactable(control))) {
        throw new Error(`control is not visible or enabled at ${page.url()}`);
      }
      await actThroughDom(control);
    };

    /** Act on a control like a person when the renderer is healthy, and
     * through the page's own DOM APIs when it is frame-idle — or when the
     * ordinary action provably failed before its click dispatched (see
     * armWitnessedAttempt). */
    const actOnControl = async (
      control: Locator,
      ordinary: () => Promise<void>,
    ): Promise<void> => {
      const healthyRenderer = await framesAreLive();
      if (healthyRenderer) {
        const attempt = await armWitnessedAttempt(control);
        if (await attempt(ordinary)) return;
      }
      await throughDomIfInteractable(control);
    };

    /** Click a control like a person (see actOnControl for the fallback). */
    const clickControl = (control: Locator): Promise<void> =>
      actOnControl(control, () => control.click({ timeout: T }));

    /** Click and let the resulting navigation settle. A scripted submit's
     * navigation starts only after the click returns, so when the URL has not
     * moved yet, wait for the commit to land — a control that deliberately
     * stays put (an in-page toggle) simply keeps its old URL. */
    const clickAndSettle = async (locator: Locator): Promise<void> => {
      const before = page.url();
      await clickControl(locator);
      await page.waitForLoadState("domcontentloaded");
      if (page.url() === before) {
        await page
          .waitForURL((url) => url.toString() !== before, {
            timeout: T,
            waitUntil: "domcontentloaded",
          })
          .catch(() => {});
      }
    };

    /** Click the first control with this role and visible name, then let the
     * resulting navigation settle. */
    const clickNamedControl = async (
      role: "button" | "link",
      text: string,
    ): Promise<void> => {
      await clickAndSettle(
        page.getByRole(role, { exact: false, name: text }).first(),
      );
      await logWhere(`${role} "${text}"`);
    };

    return {
      baseUrl,
      bodyText: () => page.locator("body").innerText({ timeout: T }),
      browser,
      check: async (name, value) => {
        log(`  check ${name}${value ? `=${value}` : ""}`);
        const control =
          value === undefined
            ? thisField(name)
            : page
                .locator(
                  `[name="${cssEscape(name)}"][value="${cssEscape(value)}"]`,
                )
                .first();
        await actOnControl(control, () => control.check({ timeout: T }));
      },
      clickButton: async (text) => {
        log(`  submit "${text}"`);
        await clickNamedControl("button", text);
      },
      clickLink: async (text) => {
        log(`  link "${text}"`);
        await clickNamedControl("link", text);
      },
      dumpPage,
      fill: async (name, value) => {
        log(`  fill ${name}`);
        await thisField(name).fill(value, { timeout: T });
      },
      goto: async (path) => {
        log(`  goto ${path}`);
        await page.goto(path, { waitUntil: "domcontentloaded" });
        await logWhere("goto");
      },
      page,
      screenshot: (label) => dumpPage(label),
      select: async (name, value) => {
        log(`  select ${name}=${value}`);
        await thisField(name).selectOption(value, { timeout: T });
      },
      submitLocator: async (locator) => {
        await clickAndSettle(locator);
        await logWhere("submit");
      },
      typeInto: async (selector, text) => {
        log(`  type into ${selector}`);
        const surface = page.locator(selector).first();
        await clickControl(surface);
        await surface.pressSequentially(text, { timeout: T });
      },
    };
  };

  return {
    baseUrl,
    browser,
    session,
    stop: async () => {
      // A frame-idle renderer can make graceful close hang, so bound it — the
      // app under test is the thing that must shut down cleanly, not this
      // scratch browser. When the graceful close really will not finish, ask
      // the browser itself to exit over CDP (also bounded).
      await Promise.race([
        browser.close(),
        new Promise((resolve) => setTimeout(resolve, 10_000)),
      ]).catch(() => {});
      if (browser.isConnected()) {
        const cdp = await browser.newBrowserCDPSession().catch(() => null);
        await Promise.race([
          cdp?.send("Browser.close").catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 5_000)),
        ]);
        if (browser.isConnected()) {
          // Playwright exposes no process handle to kill, so a surviving
          // browser is raised: the cleanup sweep fails the scenario rather
          // than leave a zombie Chromium on the runner.
          throw new Error(
            "Chromium did not close after the bounded graceful close and CDP Browser.close",
          );
        }
      }
    },
  };
};

/**
 * Capture the exact app return URL the checkout produced (e.g.
 * `/payment/success?session_id=…`). Interception proved unreliable — a
 * Stripe cross-origin redirect can slip past both page- and context-level
 * Playwright routes — so this watches the visitor's URL bar instead: the
 * moment it lands on the app's return path, that URL (the checkout's own
 * return binding, not a reconstruction) is the answer. The booking race is
 * safe without holding: the app's processed-payment reservation makes the
 * later replay idempotent whichever of the webhook or the return books
 * first, and the scenario's roster step waits for exactly one booking
 * before the replay runs.
 */
export const holdFirstAppReturn = (
  session: BrowserSession,
): { capturedUrl: () => Promise<string> } => {
  const appOrigin = new URL(session.baseUrl).origin;
  return {
    capturedUrl: async (): Promise<string> => {
      const landed = await pollUntil(90_000, () => {
        try {
          const here = new URL(session.page.url());
          return Promise.resolve(
            here.origin === appOrigin && here.pathname === "/payment/success"
              ? session.page.url()
              : null,
          );
        } catch {
          return Promise.resolve(null);
        }
      });
      if (typeof landed !== "string") {
        throw new Error(
          `the visitor never reached the app return (at ${session.page.url()})`,
        );
      }
      return landed;
    },
  };
};

/** Minimal CSS attribute-value escape for form field names. */
const cssEscape = (v: string): string => v.replace(/"/g, '\\"');
