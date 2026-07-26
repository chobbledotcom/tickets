import { chromium } from "playwright";
import { defineScreenshotBrowserLauncher } from "#scripts/browser-options.ts";
import { chromiumExecutable } from "#scripts/screenshots/browser.ts";
import { capturePreparedPage } from "#scripts/screenshots/capture.ts";
import { waitForScreenshotPage } from "#scripts/screenshots/readiness.ts";
import { readSpecCatalog } from "#scripts/specs/catalog.ts";
import { settings } from "#shared/db/settings.ts";
import { serveHandler } from "#src/serve-app.ts";
import { testCookie } from "#test-utils/session.ts";
import { defineEvidenceCapture } from "./capture-flow.ts";
import { EVIDENCE_CAPTURES } from "./declarations.ts";
import { defineLoopbackServer } from "./server.ts";

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
