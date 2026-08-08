import { dirname, fromFileUrl, join } from "@std/path";
import {
  denoCommand,
  removeTree,
  runDeno,
  stopProcess,
} from "#scripts/process.ts";
import {
  type StartupCleanup,
  startOnFirstUse,
  startWithFailureCleanup,
  waitForHealthy,
} from "#scripts/screenshots/server.ts";
import {
  reserveAvailablePort,
  startStripeMock,
  stripeMockEnv,
} from "#scripts/stripe-mock.ts";

const ROOT = dirname(dirname(dirname(fromFileUrl(import.meta.url))));
const DB_KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
const STRIPE_KEY = "sk_test_mock";
const TIMEOUT_MS = 60_000;
const RETRY_MS = 200;
const STOP_TIMEOUT_MS = 2_000;

export interface ScreenshotAppServer {
  baseUrl: string;
  enableStripe: () => Promise<void>;
  stop: () => Promise<void>;
}

const startAppServer = async ({
  add,
  run,
}: StartupCleanup): Promise<ScreenshotAppServer> => {
  const stripePort = reserveAvailablePort();
  add(stripePort.release);
  const enableStripeMock = startOnFirstUse(async () => {
    stripePort.release();
    return await startStripeMock({ port: stripePort.port });
  }, add);
  const tempDir = await Deno.makeTempDir({ prefix: "tickets-screenshots-" });
  add(() => removeTree(tempDir));
  const appPort = reserveAvailablePort();
  add(appPort.release);
  const baseUrl = `http://127.0.0.1:${appPort.port}`;
  const dbUrl = `file:${join(tempDir, "screenshots.db")}`;
  const command = denoCommand(["run", "-A", "src/index.ts"], {
    cwd: ROOT,
    env: {
      ...Deno.env.toObject(),
      ...stripeMockEnv(stripePort.port),
      DB_ENCRYPTION_KEY: DB_KEY,
      DB_URL: dbUrl,
      PORT: String(appPort.port),
    },
    stderr: "inherit",
    stdout: "null",
  });
  appPort.release();
  const child = command.spawn();
  add(() => stopProcess(child, STOP_TIMEOUT_MS));

  const deadline = Date.now() + TIMEOUT_MS;
  const healthy = await waitForHealthy(
    () => fetch(`${baseUrl}/health`),
    () => new Promise((resolvePromise) => setTimeout(resolvePromise, RETRY_MS)),
    () => Date.now() < deadline,
  );
  if (!healthy) {
    throw new Error("The screenshot app did not start within 60 seconds.");
  }
  return {
    baseUrl,
    enableStripe: async () => {
      await enableStripeMock();
      Deno.env.set("DB_ENCRYPTION_KEY", DB_KEY);
      Deno.env.set("DB_URL", dbUrl);
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.stripe.configure({
        secretKey: STRIPE_KEY,
        webhookEndpointId: "we_screenshots",
        webhookSecret: "whsec_screenshots",
      });
      await settings.update.paymentProvider("stripe");
    },
    stop: run,
  };
};

export const startScreenshotAppServer =
  async (): Promise<ScreenshotAppServer> => {
    const build = await runDeno(["task", "build:static"], ROOT);
    if (!build.success) throw new Error("Could not build static assets.");
    return await startWithFailureCleanup(startAppServer);
  };
