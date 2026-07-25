import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { chromium, type Page } from "playwright";
import { browserLaunchOptions } from "./browser-options.ts";
import {
  type ScreenshotAppServer,
  startScreenshotAppServer,
} from "./screenshots/app-server.ts";
import { chromiumExecutable } from "./screenshots/browser.ts";
import { capturePreparedPage } from "./screenshots/capture.ts";
import { isCompactWidth, isolateElementCss } from "./screenshots/checks.ts";
import type { Rgb } from "./screenshots/color.ts";
import {
  parseScreenshotOptions,
  type ScreenshotName,
  type ThemeName,
} from "./screenshots/options.ts";
import {
  MOBILE_SCREENSHOT_PROFILE,
  screenshotContextOptions,
} from "./screenshots/profile.ts";
import { waitForScreenshotPage } from "./screenshots/readiness.ts";
import {
  loadScreenshotScenario,
  type ScreenshotScenario,
} from "./screenshots/scenario.ts";
import {
  applySocialTarget,
  type SocialTargetName,
} from "./screenshots/social.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const USERNAME = "screenshots";
const PASSWORD = "screenshots-password";
const TIMEOUT_MS = 60_000;

interface SceneContext {
  listingId: string;
  publicPath: string;
}

interface Scene {
  element?: (context: SceneContext) => string;
  path: (context: SceneContext) => string;
  prepare?: (page: Page) => Promise<void>;
  verify?: (page: Page) => Promise<void>;
}

const at =
  (path: string): Scene["path"] =>
  () =>
    path;

const SCENES: Record<ScreenshotName, Scene> = {
  "activity-log": { path: at("/admin/log") },
  "add-attendee-form": {
    element: ({ listingId }) =>
      `form[action="/admin/listing/${listingId}/attendee"]`,
    path: ({ listingId }) => `/admin/listing/${listingId}/attendees`,
  },
  "attendees-list": { path: at("/admin/attendees") },
  calendar: { path: at("/admin/calendar") },
  dashboard: { path: at("/admin/") },
  groups: { path: at("/admin/groups") },
  guide: { path: at("/admin/guide") },
  listing: {
    path: ({ listingId }) => `/admin/listing/${listingId}`,
    verify: async (page) => {
      const table = await page
        .locator(".listing-breakdown-table")
        .boundingBox();
      const section = await page.locator("#income-ledger").boundingBox();
      if (!table || !section) {
        throw new Error("Could not measure the listing money summary.");
      }
      if (!isCompactWidth(table.width, section.width)) {
        throw new Error("The listing money summary fills the page width.");
      }
    },
  },
  "listing-attendees": {
    path: ({ listingId }) => `/admin/listing/${listingId}/attendees`,
  },
  "listing-form": {
    element: at('form[action="/admin/listing"]'),
    path: at("/admin/listing/new?template=custom"),
    prepare: async (page) => {
      const values: Record<string, string> = {
        location: "The Lantern Hall, Bristol",
        max_attendees: "240",
        max_quantity: "8",
        name: "Summer Sessions 2026",
        unit_price: "18.50",
      };
      for (const [name, value] of Object.entries(values)) {
        await page
          .locator(`[name="${name}"]`)
          .first()
          .fill(value, { force: true });
      }
      await page
        .locator(".md-editor .ProseMirror")
        .fill(
          "A full evening of live music, local food and independent artists.",
        );
    },
  },
  "public-listing": { path: ({ publicPath }) => publicPath },
  sessions: { path: at("/admin/sessions") },
  settings: { path: at("/admin/settings") },
  users: { path: at("/admin/users") },
};

const submit = async (page: Page, formSelector: string): Promise<void> => {
  const form = page.locator(formSelector);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }),
    form.evaluate((element) =>
      Reflect.apply(Reflect.get(element, "submit"), element, []),
    ),
  ]);
};

const setupAdmin = async (
  page: Page,
  baseUrl: string,
  username = USERNAME,
): Promise<void> => {
  await page.goto(`${baseUrl}/setup/`);
  await page.locator('[name="admin_username"]').fill(username);
  await page.locator('[name="admin_password"]').fill(PASSWORD);
  await page.locator('[name="admin_password_confirm"]').fill(PASSWORD);
  await page.locator('[name="accept_agreement"]').check();
  await submit(page, 'form[action="/setup/"]');

  await page.goto(`${baseUrl}/`);
  await page.locator('[name="username"]').fill(username);
  await page.locator('[name="password"]').fill(PASSWORD);
  await submit(page, 'form[action="/admin/login"]');

  await page.goto(`${baseUrl}/admin/settings`);
  await page.locator('[name="business_email"]').fill("hello@example.com");
  await submit(page, 'form[action="/admin/settings/business-email"]');
};

const setupApp = async (
  page: Page,
  server: ScreenshotAppServer,
): Promise<SceneContext> => {
  const { baseUrl } = server;
  await setupAdmin(page, baseUrl);
  await server.enableStripe();
  await page.goto(`${baseUrl}/admin/seeds`);
  await page.locator('[name="listing_count"]').fill("5");
  await page.locator('[name="attendees_per_listing"]').fill("8");
  await submit(page, 'form[action="/admin/seeds"]');

  await page.goto(`${baseUrl}/admin/`);
  const listingHref = await page
    .locator('a[href^="/admin/listing/"]:not([href*="/new"])')
    .first()
    .getAttribute("href");
  const listingId = listingHref?.match(/^\/admin\/listing\/(\d+)/)?.[1];
  if (!listingId) throw new Error("Could not find a seeded listing.");

  await page.goto(`${baseUrl}/admin/listing/${listingId}`);
  const publicHref = await page
    .locator('a[href*="/ticket/"]:not([href$="/qr"])')
    .first()
    .getAttribute("href");
  if (!publicHref) throw new Error("Could not find the listing's public link.");
  const publicPath = new URL(publicHref, baseUrl).pathname;
  return { listingId, publicPath };
};

const cssFor = async (theme: ThemeName): Promise<string> =>
  theme === "default"
    ? ""
    : await Deno.readTextFile(
        join(ROOT, "scripts", "screenshots", "themes", `${theme}.css`),
      );

const applyTheme = async (
  page: Page,
  baseUrl: string,
  theme: ThemeName,
  extraCss = "",
): Promise<void> => {
  await page.goto(`${baseUrl}/admin/settings-advanced`);
  const form = page.locator('form[action="/admin/settings/custom-css"]');
  await form
    .locator('[name="custom_css"]')
    .fill(`${await cssFor(theme)}\n${extraCss}`, { force: true });
  await submit(page, 'form[action="/admin/settings/custom-css"]');
};

const capture = async (
  page: Page,
  baseUrl: string,
  context: SceneContext,
  name: ScreenshotName,
  outputPath: string,
  elementSelector?: string,
): Promise<Rgb> => {
  const scene = SCENES[name];
  await page.goto(`${baseUrl}${scene.path(context)}`, {
    waitUntil: "networkidle",
  });
  await scene.prepare?.(page);
  await waitForScreenshotPage(page);
  await scene.verify?.(page);
  const screenshot = await capturePreparedPage(page, elementSelector);
  await Deno.writeFile(outputPath, screenshot.png);
  return screenshot.background;
};

const writeSocialVariants = async (
  sourcePath: string,
  outputDir: string,
  baseName: string,
  logPrefix: string,
  background: Rgb,
  targets: readonly SocialTargetName[],
): Promise<void> => {
  for (const target of targets) {
    const variantName = `${baseName}__${target}`;
    await applySocialTarget(
      sourcePath,
      join(outputDir, `${variantName}.png`),
      target,
      background,
    );
    console.log(`${logPrefix}${variantName}.png`);
  }
};

const captureScenario = async (
  scenario: ScreenshotScenario,
  page: Page,
  server: ScreenshotAppServer,
  outputDir: string,
  social: readonly SocialTargetName[] = [],
): Promise<void> => {
  const { baseUrl } = server;
  await setupAdmin(page, baseUrl, scenario.setupUsername);
  await server.enableStripe();
  await applyTheme(
    page,
    baseUrl,
    "default",
    `${scenario.css}\n${
      scenario.elementSelector
        ? isolateElementCss(scenario.elementSelector)
        : ""
    }`,
  );
  await scenario.run({
    balancePathFor: async (attendeeId) => {
      const { signBalanceToken } = await import("#shared/balance-link.ts");
      return `/pay/${await signBalanceToken(attendeeId)}`;
    },
    baseUrl,
    page,
    submit: (formSelector) => submit(page, formSelector),
  });
  await waitForScreenshotPage(page);
  const outputPath = join(outputDir, `${scenario.name}.png`);
  const screenshot = await capturePreparedPage(
    page,
    scenario.elementSelector,
    scenario.fullPage,
  );
  await Deno.writeFile(outputPath, screenshot.png);
  console.log(`${scenario.name}.png`);
  await writeSocialVariants(
    outputPath,
    outputDir,
    scenario.name,
    "",
    screenshot.background,
    social,
  );
};

const main = async (): Promise<void> => {
  Deno.env.set("PW_TEST_SCREENSHOT_NO_FONTS_READY", "1");
  const options = parseScreenshotOptions(Deno.args);
  const outputDir = resolve(ROOT, options.outputDir);
  await Deno.mkdir(outputDir, { recursive: true });
  const scenario = options.scenarioPath
    ? await loadScreenshotScenario(resolve(ROOT, options.scenarioPath))
    : undefined;
  const server = await startScreenshotAppServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const executablePath = await chromiumExecutable();
    browser = await chromium.launch(
      browserLaunchOptions(true, executablePath, [
        "--disable-features=CDPScreenshotNewSurface",
      ]),
    );
    const context = await browser.newContext({
      baseURL: server.baseUrl,
      ...screenshotContextOptions(MOBILE_SCREENSHOT_PROFILE),
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    if (scenario) {
      await captureScenario(
        scenario,
        page,
        server,
        outputDir,
        options.social ?? [],
      );
      return;
    }
    const sceneContext = await setupApp(page, server);
    for (const theme of options.themes) {
      const themeDir = join(outputDir, theme);
      await Deno.mkdir(themeDir, { recursive: true });
      for (const name of options.names) {
        const elementSelector =
          options.elementSelector ?? SCENES[name].element?.(sceneContext);
        await applyTheme(
          page,
          server.baseUrl,
          theme,
          elementSelector ? isolateElementCss(elementSelector) : "",
        );
        const outputPath = join(themeDir, `${name}.png`);
        const background = await capture(
          page,
          server.baseUrl,
          sceneContext,
          name,
          outputPath,
          elementSelector,
        );
        console.log(`${theme}/${name}.png`);
        await writeSocialVariants(
          outputPath,
          themeDir,
          name,
          `${theme}/`,
          background,
          options.social ?? [],
        );
      }
    }
  } finally {
    await browser?.close();
    await server.stop();
  }
};

if (import.meta.main) await main();
