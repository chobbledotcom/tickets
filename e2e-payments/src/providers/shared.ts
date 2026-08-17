/* jscpd:ignore-start */
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import type { BrowserSession } from "#e2e/browser.ts";
import type { ProviderName } from "#e2e/config.ts";
import { config } from "#e2e/config.ts";
import { log } from "#e2e/log.ts";
import { pollUntil } from "#e2e/util.ts";
import { readJson } from "#shared/read-json.ts";
import type { ConfigureProvider, PayHostedCheckout } from "./types.ts";

/* jscpd:ignore-end */

/**
 * Recover a provider-side id the app logged while creating a checkout (e.g.
 * `[Square] Payment link created orderId=…`, `[SumUp] Checkout created id=…`).
 * The database (and so the log) is fresh per scenario, so the id found here
 * belongs to this scenario alone; polled briefly because the log write and our
 * read race the redirect. The last match wins so a retried creation reads the
 * id that actually went live.
 */
export const readLoggedId = async (
  logPath: string,
  pattern: RegExp,
  expectedLine: string,
): Promise<string> => {
  const found = await pollUntil(10_000, () => {
    let text = "";
    try {
      text = readFileSync(logPath, "utf8");
    } catch (err) {
      // Only "not created yet" is the wait state; any other read failure is
      // a real fault the run must surface, not poll past.
      if ((err as { code?: string }).code !== "ENOENT") throw err;
    }
    let last: string | null = null;
    for (const m of text.matchAll(pattern)) last = m[1] ?? last;
    return Promise.resolve(last);
  });
  if (found) return found;
  throw new Error(
    `could not find the provider id in the app server log (${logPath}). ` +
      `Expected a '${expectedLine}' line.`,
  );
};

/**
 * A documented provider field that is absent is a broken boundary, not a
 * zero/empty value to default away: a raw sandbox response missing it fails
 * the run right here, at the provider boundary.
 */
export const requiredField = <T>(
  value: T | null | undefined,
  provider: ProviderName,
  what: string,
): T => {
  if (value === undefined || value === null || value === "") {
    throw new Error(
      `${provider}'s response is missing the documented field "${what}" — refusing to default it`,
    );
  }
  return value;
};

/** Refuse a checkout that was not paid by the provider being asked about,
 * narrowing it to that provider's checkout shape. */
export function expectProvider<
  P extends import("./types.ts").PaidSandboxCheckout["provider"],
>(
  checkout: import("./types.ts").PaidSandboxCheckout,
  provider: P,
): asserts checkout is Extract<
  import("./types.ts").PaidSandboxCheckout,
  { provider: P }
> {
  if (checkout.provider !== provider) {
    throw new Error(
      `this checkout was not paid with ${provider}: ${checkout.provider}`,
    );
  }
}

/** The honest observation for a refund that may have landed but is not yet
 * settled or visible: pending, with the observation time — never reported as
 * completed and never defaulted to a partial sum. */
export const pendingRefund =
  (): import("./types.ts").SandboxRefundObservation => ({
    kind: "pending",
    observedAt: new Date().toISOString(),
  });

/** A settled refund, carrying the actually returned amount and currency —
 * both required fields, so a provider answer missing either fails here. */
export const completedRefund = (
  provider: ProviderName,
  currency: string | null | undefined,
  returnedAmount: number,
): import("./types.ts").SandboxRefundObservation => ({
  currency: requiredField(currency, provider, "currency on the refund"),
  kind: "completed",
  returnedAmount,
});

/** The money a provider resource proves was returned, or null when the
 * resource names no refund. */
export type RefundWithin<Resource> = (
  resource: Resource,
) => { amount: number; currency: string | null | undefined } | null;

/** Read one provider resource once and turn it into a refund observation.
 * A transport failure — outage, rejected credentials, malformed body —
 * propagates: the nightly run must not report green without ever learning
 * what the provider returned. `pending` is reserved for a successful read
 * whose resource honestly reports no settled refund yet (or the SumUp
 * history's settling lag). */
export const observeViaRead = async <Resource>(
  provider: ProviderName,
  read: () => Promise<Resource>,
  refundWithin: RefundWithin<Resource>,
): Promise<import("./types.ts").SandboxRefundObservation> => {
  const resource = await read();
  const refund = refundWithin(resource);
  if (refund === null) return pendingRefund();
  return completedRefund(provider, refund.currency, refund.amount);
};

/** Build a provider's `observeRefund` from its one read plus the rule that
 * reads the refund out of the resource — the exhaustive method shape is
 * written once, here. */
export const refundObservationVia =
  <P extends import("./types.ts").ProviderName, Resource>(
    provider: P,
    read: (
      checkout: Extract<
        import("./types.ts").PaidSandboxCheckout,
        { provider: P }
      >,
      secrets: Record<string, string>,
    ) => Promise<Resource>,
    refundWithin: RefundWithin<Resource>,
  ): PaymentProviderReader =>
  async (checkout, secrets) => {
    expectProvider(checkout, provider);
    return await observeViaRead(
      provider,
      () => read(checkout, secrets),
      refundWithin,
    );
  };

/** The read-only refund-observation method every provider implements. */
type PaymentProviderReader = (
  checkout: import("./types.ts").PaidSandboxCheckout,
  secrets: Record<string, string>,
) => Promise<import("./types.ts").SandboxRefundObservation>;

/** Wait until the browser is back on the app origin and return the exact URL
 * it came back on — the checkout's own return binding, not a reconstruction. */
export const awaitReturnToApp = async (
  provider: ProviderName,
  page: Page,
  baseUrl: string,
): Promise<string> => {
  const backHome = await pollUntil(90_000, () =>
    Promise.resolve(page.url().startsWith(baseUrl) ? page.url() : null),
  );
  return requiredField(
    backHome,
    provider,
    "the return URL the browser came back on",
  );
};

/** Options for one provider REST call; `body` is already serialised. */
export interface ProviderRequest {
  body?: string;
  headers?: Record<string, string>;
  method?: string;
}

/**
 * One authenticated provider REST call that throws with the API's own answer
 * on a non-2xx and returns the parsed JSON (or `{}` for an empty body). A
 * response whose body is not valid JSON fails here, at the boundary.
 */
export const providerFetch = async (
  provider: ProviderName,
  url: string,
  init: ProviderRequest = {},
): Promise<unknown> => {
  const res = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/problem+json, application/json",
      ...(init.headers ?? {}),
    },
    method: init.method ?? "GET",
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `${provider} API ${url} → HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  if (text === "") return {};
  const parsed = await readJson(() => JSON.parse(text));
  return parsed.ok ? parsed.value : notJson(provider, text);
};

const notJson = (provider: ProviderName, text: string): never => {
  throw new Error(
    `${provider}'s response was not valid JSON: ${text.slice(0, 120)}`,
  );
};

/** A step that acts on the settings page for one named payment provider. */
type ProviderStep = (
  session: BrowserSession,
  provider: ProviderName,
) => Promise<void>;

/** Select the active payment provider via the radio form on /admin/settings. */
export const selectProvider: ProviderStep = async (session, provider) => {
  await session.goto("/admin/settings");
  await session.check("payment_provider", provider);
  await session.clickButton("Save Payment Provider");
  log(`  selected payment provider: ${provider}`);
};

/**
 * Confirm the credentials saved: each provider renders a "Test Connection"
 * button (id `<provider>-test-btn`) only once its key/token is configured.
 */
export const assertConfigured: ProviderStep = async (session, provider) => {
  const marker = session.page.locator(`#${provider}-test-btn`);
  try {
    await marker.waitFor({ state: "visible", timeout: config.navTimeoutMs });
    log(`  ${provider} credentials accepted`);
  } catch (err) {
    await session.screenshot(`configure-${provider}-failed`);
    const body = await session.bodyText();
    throw new Error(
      `${provider} did not report as configured after saving credentials.\n` +
        `Page said:\n${body.slice(0, 1_200)}\n(original: ${String(err)})`,
    );
  }
};

/**
 * Build a provider's `configure` from just its credential-saving step. Every
 * provider selects itself as the active provider, saves credentials, then
 * verifies it reports configured — only the middle step differs, so the
 * select/verify bookends live here rather than being repeated per provider.
 */
export const configureProvider =
  (
    provider: ProviderName,
    saveCredentials: ConfigureProvider,
  ): ConfigureProvider =>
  async (session, secrets) => {
    await selectProvider(session, provider);
    await saveCredentials(session, secrets);
    await assertConfigured(session, provider);
  };

/**
 * Build a provider's `payHostedCheckout` from just the step that drives its
 * hosted page. Every provider says what it is doing, then waits for the hosted
 * page's DOM before touching it — those two lines live here rather than being
 * repeated per provider, so each provider only writes its own driving step.
 */
export const hostedCheckout =
  (message: string, drive: PayHostedCheckout): PayHostedCheckout =>
  async (page, ctx) => {
    log(message);
    await page.waitForLoadState("domcontentloaded");
    return await drive(page, ctx);
  };

/** The honest no-op cleanup for providers whose sandbox resources are all
 * append-only (payments, refunds) with nothing ephemeral to remove. */
export const noProviderCleanup = (): Promise<void> => Promise.resolve();
