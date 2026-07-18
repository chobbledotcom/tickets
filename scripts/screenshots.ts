import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import { browserLaunchOptions } from "./browser-options.ts";
import { denoCommand, removeTree, runDeno } from "./process.ts";
import {
  parseScreenshotOptions,
  type ScreenshotName,
  type ThemeName,
} from "./screenshots/options.ts";
import { findAvailablePort } from "./stripe-mock.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const DB_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const USERNAME = "screenshots";
const PASSWORD = "screenshots-password";
const TIMEOUT_MS = 60_000;

interface AppServer {
  baseUrl: string;
  stop: () => Promise<void>;
}

interface SceneContext {
  listingId: string;
  publicPath: string;
}

interface Scene {
  element?: (context: SceneContext) => string;
  path: (context: SceneContext) => string;
  prepare?: (page: Page) => Promise<void>;
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
  listing: { path: ({ listingId }) => `/admin/listing/${listingId}` },
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

const startServer = async (): Promise<AppServer> => {
  const build = await runDeno(["task", "build:static"], ROOT);
  if (!build.success) throw new Error("Could not build static assets.");
  const tempDir = await Deno.makeTempDir({ prefix: "tickets-screenshots-" });
  const port = findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = denoCommand(["run", "-A", "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      DB_ENCRYPTION_KEY: DB_KEY,
      DB_URL: `file:${join(tempDir, "screenshots.db")}`,
      PORT: String(port),
    },
    stderr: "inherit",
    stdout: "null",
  }).spawn();

  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      await response.body?.cancel();
      if (response.ok) {
        return {
          baseUrl,
          stop: async () => {
            try {
              child.kill("SIGTERM");
              await child.status;
            } finally {
              await removeTree(tempDir);
            }
          },
        };
      }
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
  child.kill("SIGKILL");
  await child.status;
  await removeTree(tempDir);
  throw new Error("The screenshot app did not start within 60 seconds.");
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

const setupApp = async (page: Page, baseUrl: string): Promise<SceneContext> => {
  await page.goto(`${baseUrl}/setup/`);
  await page.locator('[name="admin_username"]').fill(USERNAME);
  await page.locator('[name="admin_password"]').fill(PASSWORD);
  await page.locator('[name="admin_password_confirm"]').fill(PASSWORD);
  await page.locator('[name="accept_agreement"]').check();
  await submit(page, 'form[action="/setup/"]');

  await page.goto(`${baseUrl}/`);
  await page.locator('[name="username"]').fill(USERNAME);
  await page.locator('[name="password"]').fill(PASSWORD);
  await submit(page, 'form[action="/admin/login"]');

  await page.goto(`${baseUrl}/admin/settings`);
  await page.locator('[name="business_email"]').fill("hello@example.com");
  await submit(page, 'form[action="/admin/settings/business-email"]');
  await page.goto(`${baseUrl}/admin/settings`);
  await page.locator('[name="payment_provider"][value="none"]').check();
  await submit(page, 'form[action="/admin/settings/payment-provider"]');

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

const isolateElementCss = (selector: string): string =>
  `body * { visibility: hidden !important; }
${selector}, ${selector} * { visibility: visible !important; }`;

interface Rgb {
  b: number;
  g: number;
  r: number;
}

const parseRgb = (color: string): Rgb => {
  const channels = color.match(/\d+/g)?.slice(0, 3).map(Number);
  if (channels?.length !== 3) {
    throw new Error(`Could not read screenshot background colour: ${color}`);
  }
  return { b: channels[2]!, g: channels[1]!, r: channels[0]! };
};

const trimElementScreenshot = async (
  png: Uint8Array,
  background: Rgb,
  outputPath: string,
): Promise<void> => {
  const padding = 32;
  const image = sharp(png);
  const source = await image.metadata();
  if (!source.width) throw new Error("The screenshot PNG has no width.");
  const result = await image
    .trim({ background, threshold: 5 })
    .extend({
      background,
      bottom: padding,
      left: padding,
      right: padding,
      top: padding,
    })
    .png()
    .toFile(outputPath);
  if (result.width === source.width + padding * 2) {
    throw new Error("The selected screenshot element has no visible content.");
  }
};

const capture = async (
  page: Page,
  baseUrl: string,
  context: SceneContext,
  name: ScreenshotName,
  outputPath: string,
  elementSelector?: string,
): Promise<void> => {
  const scene = SCENES[name];
  await page.goto(`${baseUrl}${scene.path(context)}`, {
    waitUntil: "networkidle",
  });
  await scene.prepare?.(page);
  await page.waitForFunction('document.fonts.status === "loaded"');
  if (elementSelector) {
    const element = page.locator(elementSelector).first();
    await element.waitFor({ state: "attached" });
    const initialBox = await element.boundingBox();
    if (!initialBox) {
      throw new Error(
        `Could not measure screenshot element: ${elementSelector}`,
      );
    }
    await page.setViewportSize({
      height: Math.ceil(Math.max(1000, initialBox.height + 128)),
      width: 1440,
    });
    await element.evaluate((node) =>
      Reflect.apply(Reflect.get(node, "scrollIntoView"), node, [
        { block: "center" },
      ]),
    );
    const backgroundColor = await page.locator("body").evaluate((node) => {
      const getStyle = Reflect.get(globalThis, "getComputedStyle");
      const style = Reflect.apply(getStyle, globalThis, [node]);
      if (typeof style !== "object" || style === null) {
        throw new Error("Could not read the page style.");
      }
      return String(Reflect.get(style, "backgroundColor"));
    });
    await trimElementScreenshot(
      await page.screenshot(),
      parseRgb(backgroundColor),
      outputPath,
    );
    await page.setViewportSize({ height: 1000, width: 1440 });
    return;
  }
  await page.screenshot({ path: outputPath });
};

const main = async (): Promise<void> => {
  Deno.env.set("PW_TEST_SCREENSHOT_NO_FONTS_READY", "1");
  const options = parseScreenshotOptions(Deno.args);
  const outputDir = resolve(ROOT, options.outputDir);
  await Deno.mkdir(outputDir, { recursive: true });
  const server = await startServer();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const configuredBrowser = Deno.env.get("CHROMIUM_EXECUTABLE");
    const nixBrowser = "/etc/profiles/per-user/user/bin/chromium";
    const executablePath =
      configuredBrowser ??
      (await Deno.stat(nixBrowser)
        .then(() => nixBrowser)
        .catch(() => undefined));
    browser = await chromium.launch(
      browserLaunchOptions(true, executablePath, [
        "--disable-features=CDPScreenshotNewSurface",
      ]),
    );
    const context = await browser.newContext({
      baseURL: server.baseUrl,
      colorScheme: "light",
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    const sceneContext = await setupApp(page, server.baseUrl);
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
        await capture(
          page,
          server.baseUrl,
          sceneContext,
          name,
          outputPath,
          elementSelector,
        );
        console.log(`${theme}/${name}.png`);
      }
    }
  } finally {
    await browser?.close();
    await server.stop();
  }
};

if (import.meta.main) await main();
