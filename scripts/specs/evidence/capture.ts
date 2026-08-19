import { chromium } from "playwright";
import { settings } from "#db/settings.ts";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { capturePreparedPage } from "#scripts/screenshots/capture.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";
import { readSpecCatalog } from "#scripts/specs/catalog.ts";
import { serveHandler } from "#src/serve-app.ts";
import { testCookie } from "#test-utils/session.ts";
import { defineEvidenceCapture } from "./capture-flow.ts";
import { EVIDENCE_CAPTURES } from "./declarations.ts";
import type { CaptureScenario } from "./hook.ts";
import { defineLoopbackServer } from "./server.ts";
import { readEvidenceTheme } from "./themes.ts";

export const captureCurrentScenarioEvidence: CaptureScenario =
  defineEvidenceCapture({
    capturePage: capturePreparedPage,
    declarations: EVIDENCE_CAPTURES,
    getCookie: testCookie,
    launchBrowser: defineScreenshotBrowserLauncher(
      chromium,
      chromiumExecutable,
    ),
    readCatalog: readSpecCatalog,
    readTheme: readEvidenceTheme,
    startServer: defineLoopbackServer(serveHandler),
    waitForPage: waitForScreenshotPage,
    writeCss: settings.update.customCss,
  });
