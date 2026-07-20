/**
 * Entrypoint for the payment sandbox e2e run.
 *
 *   npm run e2e -- <stripe|square|sumup|free>
 *   E2E_PROVIDER=stripe npm run e2e
 *
 * Boots the real app server against a throwaway DB, (optionally) exposes it via
 * a cloudflared tunnel, then drives a real browser through a full paid booking
 * against the provider's sandbox — card entry on the hosted checkout included.
 * "free" runs the same journey without money (harness self-test; no secrets).
 *
 * Exit codes: 0 = passed (or skipped for lack of secrets), 1 = failed.
 */

import { appendFileSync, readFileSync } from "node:fs";
import { type BrowserSession, launchBrowser } from "./browser.ts";
import { config, needsTunnel, providerSecrets, type Target } from "./config.ts";
import {
  assertFreeThankYou,
  assertPaidBookingConfirmed,
  assertRedirectedToCheckout,
  createListing,
  login,
  runSetup,
  submitBooking,
} from "./flow.ts";
import { fail, log, step, warn } from "./log.ts";
import { notifyFailure } from "./notify.ts";
import { runComplexOrderJourney } from "./order-flow.ts";
import { providers } from "./providers/index.ts";
import type { PaymentProvider } from "./providers/types.ts";
import { type AppServer, buildStaticAssets, startAppServer } from "./server.ts";
import { noTunnel, startTunnel, type Tunnel } from "./tunnel.ts";

/**
 * Print the tail of the app server's log to stdout. On CI the server log is
 * only saved as an artifact, so a server-side failure (e.g. "Failed to create
 * payment session" — the real provider API error is logged there, not shown in
 * the browser) is invisible in the job output. Surfacing it makes the job log
 * self-diagnosing without downloading artifacts.
 */
const dumpServerLog = (logPath: string, lines = 20): void => {
  try {
    const all = readFileSync(logPath, "utf8").split("\n");
    // The app logs one SQL statement per line, so a raw tail is almost all
    // noise. Pull out the lines that actually explain a failure — provider
    // API calls and errors — then add a short tail for surrounding context.
    const RELEVANT =
      /error|declin|fail|invalid|\[payment\]|\[stripe\]|\[square\]|\[sumup\]/i;
    const IGNORE = /\[SQL\]|\[Request\]/i;
    const signal = all.filter((l) => RELEVANT.test(l) && !IGNORE.test(l));
    warn(`----- app server log: relevant lines (${logPath}) -----`);
    warn((signal.length ? signal : all.slice(-lines)).join("\n"));
    warn(`----- app server log: last ${lines} lines -----`);
    warn(all.slice(-lines).join("\n"));
    warn("----- end app server log -----");
  } catch (err) {
    warn(`could not read app server log ${logPath}: ${String(err)}`);
  }
};

const parseTarget = (): Target => {
  const raw = (
    process.argv[2] ??
    process.env.E2E_PROVIDER ??
    "free"
  ).toLowerCase();
  if (
    raw === "free" ||
    raw === "stripe" ||
    raw === "square" ||
    raw === "sumup"
  ) {
    return raw;
  }
  throw new Error(
    `unknown target "${raw}" (expected stripe|square|sumup|free)`,
  );
};

type ConfiguredPayment = {
  provider: PaymentProvider;
  secrets: Record<string, string>;
};

const runJourneys = async ({
  country,
  payment,
  server,
  session,
  tunnel,
}: {
  country: string;
  payment: ConfiguredPayment | null;
  server: AppServer;
  session: BrowserSession;
  tunnel: Tunnel;
}): Promise<void> => {
  await runSetup(session, country);
  await login(session);

  if (payment) {
    await payment.provider.configure(session, payment.secrets);
  }

  const ticketPath = await createListing(session, {
    priceMinor: payment ? config.unitPrice : 0,
  });
  await submitBooking(session, ticketPath);

  let payForComplexOrder: (() => Promise<void>) | undefined;
  if (!payment) {
    await assertFreeThankYou(session);
  } else {
    const hostedCheckoutContext = {
      baseUrl: tunnel.publicBaseUrl,
      paymentSessionId: null as string | null,
      secrets: payment.secrets,
      serverLogPath: server.logPath,
    };
    const payOnHostedCheckout = async (message: string): Promise<void> => {
      step(message);
      await assertRedirectedToCheckout(session);
      const appReturn = session.page.waitForRequest(
        (request) => {
          const url = new URL(request.url());
          return (
            url.origin === new URL(tunnel.publicBaseUrl).origin &&
            url.pathname === "/payment/success"
          );
        },
        { timeout: config.paymentConfirmTimeoutMs },
      );
      await payment.provider.payHostedCheckout(
        session.page,
        hostedCheckoutContext,
      );
      hostedCheckoutContext.paymentSessionId = new URL(
        (await appReturn).url(),
      ).searchParams.get("session_id");
    };
    await payOnHostedCheckout(
      `Paying on the ${payment.provider.name} hosted checkout`,
    );
    await assertPaidBookingConfirmed(session, ticketPath);
    await payment.provider.afterPaidBooking?.(session, hostedCheckoutContext);
    payForComplexOrder = () =>
      payOnHostedCheckout(
        `Paying the complex order on the ${payment.provider.name} hosted checkout`,
      );
  }

  // The second journey on the same server: a COMPLEX order — a package, one
  // member also on its own row, and a plain listing, all booked through the
  // /order gallery in one checkout, then verified path-by-path in admin.
  await runComplexOrderJourney(session, {
    paid: payment !== null,
    ...(payForComplexOrder ? { payHostedCheckout: payForComplexOrder } : {}),
  });
};

const reportFailure = async (
  error: unknown,
  target: Target,
  session: BrowserSession | null,
  server: AppServer | null,
): Promise<never> => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`FAIL — ${target}: ${message}`);
  // Each step is isolated so a failure in one cannot skip the rest or
  // replace the original error a caller is about to rethrow.
  if (session) await session.screenshot(`fail-${target}`).catch(() => {});
  if (server) dumpServerLog(server.logPath);
  // notifyFailure has its own internal try/catch, but guard the await so a
  // future change to that helper can never overwrite the journey error: the
  // original error must always be the one rethrown, regardless of ntfy state.
  await notifyFailure(target).catch(() => {});
  throw error;
};

const stopRun = async (
  session: BrowserSession | null,
  tunnel: Tunnel | null,
  payment: ConfiguredPayment | null,
  server: AppServer | null,
): Promise<void> => {
  // Each teardown step is isolated so a failure in one cannot prevent the
  // rest from running — otherwise a failed session.stop could leave the
  // app-server child alive and the CI job would hang instead of failing.
  if (session) await session.stop().catch(() => {});
  if (tunnel) await tunnel.stop().catch(() => {});
  // Cleanup is best-effort because this runs after both passes and failures.
  // A failed provider cleanup must not hide the original journey result.
  if (payment?.provider.cleanup) {
    await payment.provider.cleanup(payment.secrets).catch(() => {});
  }
  if (server) await server.stop().catch(() => {});
};

type RunResult = "executed" | "skipped";

const run = async (): Promise<RunResult> => {
  const target = parseTarget();
  step(`Payment sandbox e2e — target: ${target}`);

  const provider = target === "free" ? null : providers[target];
  const secrets = provider ? providerSecrets(provider.name) : {};
  if (provider && !secrets) {
    log(`SKIP: no sandbox secrets configured for ${target}; nothing to run.`);
    return "skipped";
  }
  const payment = provider && secrets ? { provider, secrets } : null;

  const country =
    process.env.SETUP_COUNTRY?.trim() ||
    provider?.setupCountry ||
    config.setupCountry;

  // Resources are declared up front and acquired inside the try, so a failure
  // during startup (tunnel/browser) still tears down whatever was created —
  // otherwise the app-server child keeps the Node process alive and the CI job
  // hangs instead of failing cleanly.
  let server: Awaited<ReturnType<typeof startAppServer>> | null = null;
  let tunnel: Awaited<ReturnType<typeof startTunnel>> | null = null;
  let session: Awaited<ReturnType<typeof launchBrowser>> | null = null;

  try {
    await buildStaticAssets();
    server = await startAppServer();
    tunnel = needsTunnel(target)
      ? await startTunnel(server.port)
      : noTunnel(server.localBaseUrl);
    session = await launchBrowser(tunnel.publicBaseUrl);
    log(`Driving the app at ${tunnel.publicBaseUrl}`);

    await runJourneys({ country, payment, server, session, tunnel });

    step(`PASS — ${target} end-to-end booking completed`);
  } catch (err) {
    await reportFailure(err, target, session, server);
  } finally {
    await stopRun(session, tunnel, payment, server);
  }
  return "executed";
};

const publishResult = (result: RunResult): void => {
  log(`RESULT: ${result}`);
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `result=${result}\n`);
};

run()
  .then(publishResult)
  .catch((err) => {
    fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
