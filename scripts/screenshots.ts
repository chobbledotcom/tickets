import { dirname, fromFileUrl, join, resolve } from "@std/path";
import { chromium, type Page } from "playwright";
import sharp from "sharp";
import { browserLaunchOptions } from "./browser-options.ts";
import { rethrowUnlessNotFound } from "./not-found.ts";
import { denoCommand, removeTree, runDeno, stopProcess } from "./process.ts";
import {
  isCompactWidth,
  isolateElementCss,
  wasImageTrimmed,
} from "./screenshots/checks.ts";
import {
  parseScreenshotOptions,
  type ScreenshotName,
  type ThemeName,
} from "./screenshots/options.ts";
import {
  loadScreenshotScenario,
  type ScreenshotScenario,
} from "./screenshots/scenario.ts";
import {
  type StartupCleanup,
  startWithFailureCleanup,
  waitForHealthy,
} from "./screenshots/server.ts";
import {
  findAvailablePort,
  startStripeMock,
  stripeMockEnv,
} from "./stripe-mock.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const DB_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const USERNAME = "screenshots";
const PASSWORD = "screenshots-password";
const STRIPE_KEY = "sk_test_mock";
const TIMEOUT_MS = 60_000;
const RETRY_MS = 200;
const STOP_TIMEOUT_MS = 2_000;
const MOBILE_VIEWPORT = { height: 844, width: 390 };

interface AppServer {
  baseUrl: string;
  enableStripe: () => Promise<void>;
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

const startAppServer = async ({
  add,
  run,
}: StartupCleanup): Promise<AppServer> => {
  const stripeMock = await startStripeMock();
  add(stripeMock.stop);
  const tempDir = await Deno.makeTempDir({ prefix: "tickets-screenshots-" });
  add(() => removeTree(tempDir));
  const port = findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const dbUrl = `file:${join(tempDir, "screenshots.db")}`;
  const child = denoCommand(["run", "-A", "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      ...stripeMockEnv(stripeMock.port),
      DB_ENCRYPTION_KEY: DB_KEY,
      DB_URL: dbUrl,
      PORT: String(port),
    },
    stderr: "inherit",
    stdout: "null",
  }).spawn();
  add(() => stopProcess(child, STOP_TIMEOUT_MS));

  const deadline = Date.now() + TIMEOUT_MS;
  const healthy = await waitForHealthy(
    () => fetch(`${baseUrl}/health`),
    () => new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_MS)),
    () => Date.now() < deadline,
  );
  if (healthy) {
    return {
      baseUrl,
      enableStripe: async () => {
        Deno.env.set("DB_ENCRYPTION_KEY", DB_KEY);
        Deno.env.set("DB_URL", dbUrl);
        const { settings } = await import("#shared/db/settings.ts");
        await settings.update.stripe.activate({
          secretKey: STRIPE_KEY,
          webhookEndpointId: "we_screenshots",
          webhookSecret: "whsec_screenshots",
        });
      },
      stop: run,
    };
  }
  throw new Error("The screenshot app did not start within 60 seconds.");
};

const startServer = async (): Promise<AppServer> => {
  const build = await runDeno(["task", "build:static"], ROOT);
  if (!build.success) throw new Error("Could not build static assets.");
  return await startWithFailureCleanup(startAppServer);
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
  server: AppServer,
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
  if (!source.width || !source.height) {
    throw new Error("The screenshot PNG has no size.");
  }
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
  if (!wasImageTrimmed(source, result, padding)) {
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
  await scene.verify?.(page);
  await capturePreparedPage(page, outputPath, elementSelector);
};

const capturePreparedPage = async (
  page: Page,
  outputPath: string,
  elementSelector?: string,
  fullPage = false,
): Promise<void> => {
  if (elementSelector) {
    const initialViewport = page.viewportSize();
    if (!initialViewport) {
      throw new Error("Could not read the screenshot viewport.");
    }
    const element = page.locator(elementSelector).first();
    await element.waitFor({ state: "attached" });
    const initialBox = await element.boundingBox();
    if (!initialBox) {
      throw new Error(
        `Could not measure screenshot element: ${elementSelector}`,
      );
    }
    await page.setViewportSize({
      height: Math.ceil(
        Math.max(initialViewport.height, initialBox.height + 128),
      ),
      width: initialViewport.width,
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
    await page.setViewportSize(initialViewport);
    return;
  }
  await page.screenshot({ fullPage, path: outputPath });
};

const captureScenario = async (
  scenario: ScreenshotScenario,
  page: Page,
  server: AppServer,
  outputDir: string,
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
      Deno.env.set("DB_ENCRYPTION_KEY", DB_KEY);
      const { signBalanceToken } = await import("#shared/balance-link.ts");
      return `/pay/${await signBalanceToken(attendeeId)}`;
    },
    baseUrl,
    page,
    submit: (formSelector) => submit(page, formSelector),
  });
  await page.waitForFunction('document.fonts.status === "loaded"');
  const outputPath = join(outputDir, `${scenario.name}.png`);
  await capturePreparedPage(
    page,
    outputPath,
    scenario.elementSelector,
    scenario.fullPage,
  );
  console.log(`${scenario.name}.png`);
};

const chromiumExecutable = async (): Promise<string | undefined> => {
  const configured = Deno.env.get("CHROMIUM_EXECUTABLE");
  if (configured) return configured;
  const nixBrowser = "/etc/profiles/per-user/user/bin/chromium";
  try {
    await Deno.stat(nixBrowser);
    return nixBrowser;
  } catch (error) {
    rethrowUnlessNotFound(error);
    return;
  }
};

const main = async (): Promise<void> => {
  Deno.env.set("PW_TEST_SCREENSHOT_NO_FONTS_READY", "1");
  const options = parseScreenshotOptions(Deno.args);
  const outputDir = resolve(ROOT, options.outputDir);
  await Deno.mkdir(outputDir, { recursive: true });
  const scenario = options.scenarioPath
    ? await loadScreenshotScenario(resolve(ROOT, options.scenarioPath))
    : undefined;
  const server = await startServer();
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
      colorScheme: "light",
      deviceScaleFactor: 2,
      reducedMotion: "reduce",
      viewport: MOBILE_VIEWPORT,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    if (scenario) {
      await captureScenario(scenario, page, server, outputDir);
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
