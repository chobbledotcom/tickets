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

import { readFileSync } from "node:fs";
import { config, needsTunnel, type Target, providerSecrets } from "./config.ts";
import { fail, log, step, warn } from "./log.ts";
import { launchBrowser } from "./browser.ts";
import { providers } from "./providers/index.ts";
import {
  assertFreeThankYou,
  assertPaidBookingConfirmed,
  assertRedirectedToCheckout,
  createListing,
  login,
  runSetup,
  submitBooking,
} from "./flow.ts";
import { buildStaticAssets, startAppServer } from "./server.ts";
import { noTunnel, startTunnel } from "./tunnel.ts";

/**
 * Print the tail of the app server's log to stdout. On CI the server log is
 * only saved as an artifact, so a server-side failure (e.g. "Failed to create
 * payment session" — the real provider API error is logged there, not shown in
 * the browser) is invisible in the job output. Surfacing it makes the job log
 * self-diagnosing without downloading artifacts.
 */
const dumpServerLog = (logPath: string, lines = 40): void => {
  try {
    const all = readFileSync(logPath, "utf8").split("\n");
    const tail = all.slice(-lines).join("\n");
    warn(`----- app server log (last ${lines} lines of ${logPath}) -----`);
    console.error(tail);
    warn("----- end app server log -----");
  } catch (err) {
    warn(`could not read app server log ${logPath}: ${String(err)}`);
  }
};

const parseTarget = (): Target => {
  const raw = (process.argv[2] ?? process.env.E2E_PROVIDER ?? "free").toLowerCase();
  if (raw === "free" || raw === "stripe" || raw === "square" || raw === "sumup") {
    return raw;
  }
  throw new Error(`unknown target "${raw}" (expected stripe|square|sumup|free)`);
};

const run = async (): Promise<void> => {
  const target = parseTarget();
  step(`Payment sandbox e2e — target: ${target}`);

  const provider = target === "free" ? null : providers[target];
  const secrets = provider ? providerSecrets(provider.name) : {};
  if (provider && !secrets) {
    log(`SKIP: no sandbox secrets configured for ${target}; nothing to run.`);
    return; // exit 0 — a missing-secret leg is a skip, not a failure
  }

  const country =
    process.env.SETUP_COUNTRY?.trim() || provider?.setupCountry || config.setupCountry;

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

    await runSetup(session, country);
    await login(session);

    if (provider) await provider.configure(session, secrets!);

    const ticketPath = await createListing(session, {
      priceMinor: provider ? config.unitPrice : 0,
    });
    await submitBooking(session, ticketPath);

    if (!provider) {
      await assertFreeThankYou(session);
    } else {
      step(`Paying on the ${provider.name} hosted checkout`);
      await assertRedirectedToCheckout(session);
      await provider.payHostedCheckout(session.page);
      await assertPaidBookingConfirmed(session, ticketPath);
    }

    step(`PASS — ${target} end-to-end booking completed`);
  } catch (err) {
    fail(`FAIL — ${target}: ${err instanceof Error ? err.message : String(err)}`);
    if (session) await session.screenshot(`fail-${target}`);
    if (server) dumpServerLog(server.logPath);
    throw err;
  } finally {
    if (session) await session.stop();
    if (tunnel) await tunnel.stop();
    // Remove any ephemeral provider-side resources (e.g. Stripe webhook
    // endpoints) regardless of pass/fail, before stopping the server.
    if (provider?.cleanup && secrets) {
      await provider.cleanup(secrets).catch(() => {});
    }
    if (server) await server.stop();
  }
};

run().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
