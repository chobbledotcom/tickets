import { Buffer } from "node:buffer";
import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import { launchScreenshotChromium } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { capturePreparedPage } from "#scripts/screenshots/capture.ts";
import {
  SCREENSHOT_PROFILES,
  screenshotContextOptions,
} from "#scripts/screenshots/profile.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";
import { readSpecCatalog } from "#scripts/specs/catalog.ts";
import { settings } from "#shared/db/settings.ts";
import { requireValue } from "#shared/required-value.ts";
import { serveHandler } from "#src/serve-app.ts";
import { testCookie } from "#test-utils/session.ts";
import { isAllowedEvidenceRequest, resolveEvidencePath } from "./browser.ts";
import { EVIDENCE_CAPTURES } from "./declarations.ts";
import type { EvidenceHookCase, EvidenceWorld } from "./hook.ts";
import { resolveEvidenceScenario } from "./resolve.ts";
import { parseEvidenceDeclarations } from "./schema.ts";
import { storeEvidenceCss } from "./style.ts";

/** Per-page capture timeout. The After hook has EVIDENCE_HOOK_TIMEOUT_MS
 * (hook.ts) for all captures in one scenario; keep the declaration×profile
 * count small enough to fit within it as EVIDENCE_CAPTURES grows. */
const CAPTURE_TIMEOUT_MS = 60_000;

interface LoopbackServer {
  baseUrl: string;
  close: () => Promise<void>;
}

const startLoopbackServer = (): LoopbackServer => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", onListen: () => {}, port: 0 },
    serveHandler,
  );
  const address = server.addr;
  if (address.transport !== "tcp") {
    throw new Error("Evidence server did not open a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await server.shutdown();
      await server.finished;
    },
  };
};

const browserCookie = async (
  baseUrl: string,
): Promise<{ name: string; url: string; value: string }> => {
  const pair = requireValue(
    (await testCookie()).split(";", 1)[0],
    "Test owner cookie is missing",
  );
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
  declaration: (typeof EVIDENCE_CAPTURES)[number],
  profileName: keyof typeof SCREENSHOT_PROFILES,
): Promise<void> => {
  const profile = SCREENSHOT_PROFILES[profileName];
  await storeEvidenceCss(declaration, settings.update.customCss);
  const context = await browser.newContext({
    baseURL: baseUrl,
    ...screenshotContextOptions(profile),
  });
  const blocked = new Set<string>();
  try {
    await blockOutboundRequests(context, baseUrl, blocked);
    await context.addCookies([await browserCookie(baseUrl)]);
    const page = await context.newPage();
    page.setDefaultTimeout(CAPTURE_TIMEOUT_MS);
    await page.goto(
      resolveEvidencePath(declaration.path, world.evidenceValues),
      {
        waitUntil: "domcontentloaded",
      },
    );
    await waitForScreenshotPage(page);
    assertNoBlockedRequests(blocked);
    const { png } = await capturePreparedPage(page, declaration.element);
    await world.attach(Buffer.from(png), {
      fileName: `${declaration.id}--${profile.name}.png`,
      mediaType: "image/png",
    });
  } finally {
    await context.close();
  }
};

export const captureCurrentScenarioEvidence = async (
  world: EvidenceWorld,
  hook: EvidenceHookCase,
): Promise<void> => {
  const catalog = await readSpecCatalog();
  const declarations = parseEvidenceDeclarations(EVIDENCE_CAPTURES, catalog);
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
  const server = startLoopbackServer();
  let browser: Browser | undefined;
  try {
    browser = await launchScreenshotChromium(
      chromium,
      await chromiumExecutable(),
    );
    for (const declaration of selected) {
      for (const profile of declaration.profiles) {
        await captureProfile(
          browser,
          server.baseUrl,
          world,
          declaration,
          profile,
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
