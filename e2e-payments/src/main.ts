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

import { config, needsTunnel, type Target, providerSecrets } from "./config.ts";
import { fail, log, step } from "./log.ts";
import { launchBrowser } from "./browser.ts";
import { providers } from "./providers/index.ts";
import {
  assertFreeThankYou,
  assertPaidBookingConfirmed,
  createListing,
  login,
  runSetup,
  submitBooking,
} from "./flow.ts";
import { buildStaticAssets, startAppServer } from "./server.ts";
import { noTunnel, startTunnel } from "./tunnel.ts";

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

  await buildStaticAssets();
  const server = await startAppServer();
  const tunnel = needsTunnel(target)
    ? await startTunnel(server.port)
    : noTunnel(server.localBaseUrl);
  const session = await launchBrowser(tunnel.publicBaseUrl);
  log(`Driving the app at ${tunnel.publicBaseUrl}`);

  try {
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
      await provider.payHostedCheckout(session.page);
      await assertPaidBookingConfirmed(session, ticketPath);
    }

    step(`PASS — ${target} end-to-end booking completed`);
  } catch (err) {
    fail(`FAIL — ${target}: ${err instanceof Error ? err.message : String(err)}`);
    await session.screenshot(`fail-${target}`);
    throw err;
  } finally {
    await session.stop();
    await tunnel.stop();
    await server.stop();
  }
};

run().catch((err) => {
  fail(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
