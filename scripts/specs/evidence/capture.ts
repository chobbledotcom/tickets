import { Buffer } from "node:buffer";
import type { Browser, BrowserContext, Page } from "playwright";
import { chromium } from "playwright";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { capturePreparedPage } from "#scripts/screenshots/capture.ts";
import {
  SCREENSHOT_PROFILES,
  screenshotContextOptions,
} from "#scripts/screenshots/profile.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";
import { readSpecCatalog } from "#scripts/specs/catalog.ts";
import type { SpecCatalog } from "#scripts/specs/types.ts";
import { settings } from "#shared/db/settings.ts";
import { serveHandler } from "#src/serve-app.ts";
import { testCookie } from "#test-utils/session.ts";
import { isAllowedEvidenceRequest, resolveEvidencePath } from "./browser.ts";
import { EVIDENCE_CAPTURES } from "./declarations.ts";
import type {
  CaptureScenario,
  EvidenceHookCase,
  EvidenceWorld,
} from "./hook.ts";
import { resolveEvidenceScenario } from "./resolve.ts";
import {
  type EvidenceCaptureDeclaration,
  parseEvidenceDeclarations,
} from "./schema.ts";
import { defineLoopbackServer, type LoopbackServer } from "./server.ts";
import { storeEvidenceCss } from "./style.ts";

/** Per-page capture timeout. The After hook has EVIDENCE_HOOK_TIMEOUT_MS
 * (hook.ts) for all captures in one scenario; keep the declaration×profile
 * count small enough to fit within it as EVIDENCE_CAPTURES grows. */
const CAPTURE_TIMEOUT_MS = 60_000;

interface EvidenceCaptureDependencies {
  capturePage: (
    page: Page,
    elementSelector?: string,
  ) => Promise<{ png: Uint8Array }>;
  declarations: readonly EvidenceCaptureDeclaration[];
  getCookie: () => Promise<string>;
  launchBrowser: () => Promise<Browser>;
  readCatalog: () => Promise<SpecCatalog>;
  startServer: () => LoopbackServer;
  waitForPage: (page: Page) => Promise<void>;
  writeCss: (css: string) => Promise<void>;
}

const browserCookie = async (
  baseUrl: string,
  getCookie: () => Promise<string>,
): Promise<{ name: string; url: string; value: string }> => {
  const [pair] = (await getCookie()).split(";", 1);
  if (!pair) throw new Error("Test owner cookie is malformed");
  const splitAt = pair.indexOf("=");
  if (splitAt < 1 || splitAt === pair.length - 1) {
    throw new Error("Test owner cookie is malformed");
  }
  return {
    name: pair.slice(0, splitAt),
    url: baseUrl,
    value: pair.slice(splitAt + 1),
  };
};

const blockOutboundRequests = async (
  context: BrowserContext,
  baseUrl: string,
  blocked: Set<string>,
): Promise<void> => {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (isAllowedEvidenceRequest(baseUrl, url.href)) {
      await route.continue();
      return;
    }
    blocked.add(url.href);
    await route.abort("blockedbyclient");
  });
};

const assertNoBlockedRequests = (blocked: ReadonlySet<string>): void => {
  if (blocked.size === 0) return;
  throw new Error(
    `Evidence page requested blocked URLs: ${[...blocked].sort().join(", ")}`,
  );
};

const captureProfile = async (
  browser: Browser,
  baseUrl: string,
  world: EvidenceWorld,
  declaration: EvidenceCaptureDeclaration,
  profileName: keyof typeof SCREENSHOT_PROFILES,
  dependencies: EvidenceCaptureDependencies,
): Promise<void> => {
  const profile = SCREENSHOT_PROFILES[profileName];
  await storeEvidenceCss(declaration, dependencies.writeCss);
  const context = await browser.newContext({
    baseURL: baseUrl,
    ...screenshotContextOptions(profile),
  });
  const blocked = new Set<string>();
  try {
    await blockOutboundRequests(context, baseUrl, blocked);
    await context.addCookies([
      await browserCookie(baseUrl, dependencies.getCookie),
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(CAPTURE_TIMEOUT_MS);
    await page.goto(
      resolveEvidencePath(declaration.path, world.evidenceValues),
      { waitUntil: "domcontentloaded" },
    );
    await dependencies.waitForPage(page);
    const { png } = await dependencies.capturePage(page, declaration.element);
    assertNoBlockedRequests(blocked);
    await world.attach(Buffer.from(png), {
      fileName: `${declaration.id}--${profile.name}.png`,
      mediaType: "image/png",
    });
  } finally {
    await context.close();
  }
};

export const defineEvidenceCapture =
  (dependencies: EvidenceCaptureDependencies): CaptureScenario =>
  async (world: EvidenceWorld, hook: EvidenceHookCase) => {
    const catalog = await dependencies.readCatalog();
    const declarations = parseEvidenceDeclarations(
      dependencies.declarations,
      catalog,
    );
    const scenario = resolveEvidenceScenario(
      catalog,
      hook.gherkinDocument,
      hook.pickle,
    );
    const selected = declarations.filter(
      ({ caseId }) => caseId === scenario.case.id,
    );
    if (selected.length === 0) {
      throw new Error(
        `No evidence capture declared for @case:${scenario.case.id}`,
      );
    }
    const server = dependencies.startServer();
    let browser: Browser | undefined;
    try {
      browser = await dependencies.launchBrowser();
      for (const declaration of selected) {
        for (const profile of declaration.profiles) {
          await captureProfile(
            browser,
            server.baseUrl,
            world,
            declaration,
            profile,
            dependencies,
          );
        }
      }
    } finally {
      try {
        await browser?.close();
      } finally {
        await server.close();
      }
    }
  };

export const captureCurrentScenarioEvidence = defineEvidenceCapture({
  capturePage: capturePreparedPage,
  declarations: EVIDENCE_CAPTURES,
  getCookie: testCookie,
  launchBrowser: defineScreenshotBrowserLauncher(chromium, chromiumExecutable),
  readCatalog: readSpecCatalog,
  startServer: defineLoopbackServer(serveHandler),
  waitForPage: waitForScreenshotPage,
  writeCss: settings.update.customCss,
});
