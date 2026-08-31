/* jscpd:ignore-start */
import { readFileSync } from "node:fs";
import type { Page } from "playwright";
import { type BrowserSession, fillAndSubmit } from "#e2e/browser.ts";
import { catalogWords } from "#e2e/catalog-words.ts";
import type { ProviderName } from "#e2e/config.ts";
import { config } from "#e2e/config.ts";
import { log } from "#e2e/log.ts";
import { pollUntil } from "#e2e/util.ts";
import { mapNotNullish } from "#fp";
import { PROVIDER_TIMEOUT_MS } from "#payment/provider-fetch.ts";
import { PAYMENT_PROVIDERS } from "#shared/payment-providers.ts";
import { readJson } from "#shared/read-json.ts";
import type { ConfigureProvider, PayHostedCheckout } from "./types.ts";

/* jscpd:ignore-end */

/**
 * The last value the app server has logged for this pattern, or null when its
 * log carries none — the pattern's first group is the value. The pattern is
 * source text, not a `RegExp`, so a caller cannot hand over the one shape
 * `matchAll` refuses (a non-global pattern): this compiles it global itself.
 * A log file that does not exist yet reads as "nothing logged so far"; any
 * other read failure is a real fault and is raised rather than polled past.
 */
export const lastLoggedMatch = (
  logPath: string,
  pattern: string,
): string | null => {
  let text = "";
  try {
    text = readFileSync(logPath, "utf8");
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") throw err;
  }
  const values = mapNotNullish((match: RegExpMatchArray) => match[1])([
    ...text.matchAll(new RegExp(pattern, "g")),
  ]);
  return values.at(-1) ?? null;
};

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
  pattern: string,
  expectedLine: string,
): Promise<string> => {
  const found = await pollUntil(10_000, () =>
    Promise.resolve(lastLoggedMatch(logPath, pattern)),
  );
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

/**
 * Refuses when the provider in hand is not the one being asked for. The caller
 * says what the two are, because a scenario running against the wrong target
 * and a checkout paid by the wrong provider need different words. The name
 * type is the caller's, so a harness target — which can also be "free" — is
 * held to its own vocabulary rather than to a payment provider's.
 */
export const refuseOtherProvider =
  <Name extends string>(say: (wanted: Name, inHand: Name) => string) =>
  (wanted: Name, inHand: Name): void => {
    if (inHand !== wanted) throw new Error(say(wanted, inHand));
  };

const refuseAnotherPayer = refuseOtherProvider(
  (wanted, paidWith) =>
    `this checkout was not paid with ${wanted}: ${paidWith}`,
);

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
  refuseAnotherPayer(provider, checkout.provider);
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
 * response whose body is not valid JSON fails here, at the boundary. Bounded
 * by the same allowance the production transports use, so a hung sandbox
 * read fails its step instead of outliving the scenario's hooks.
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
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
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
  await session.clickButton(
    await catalogWords("settings", "settings.save_payment_provider"),
  );
  log(`  selected payment provider: ${provider}`);
};

/**
 * Fill one provider's credentials and save them with the button the settings
 * page renders for that provider. The words come from the same message
 * catalog the app renders, so a copy rename cannot strand this driver on a
 * label that no longer exists. If the app under test is ever rebranded
 * through I18N_REPLACEMENTS, this process needs that env too.
 */
export const saveCredentials = async (
  session: BrowserSession,
  provider: ProviderName,
  values: Record<string, string>,
): Promise<void> =>
  fillAndSubmit(
    session,
    values,
    await catalogWords("settings", "settings.provider.update_credentials", {
      provider: PAYMENT_PROVIDERS[provider].label,
    }),
  );

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

/** What one provider's connection test must say to count as passed. */
export type ConnectionCheck = {
  /** The line logged when it passes. */
  passed: string;
  /** Lines the answer must carry. */
  require: readonly string[];
  /** One more rule the provider owns, naming what is wrong, or null. */
  alsoWrong?: ((text: string) => string | null) | undefined;
};

/**
 * Ask a provider's "Test Connection" button, and read what it answered.
 *
 * A provider says only which lines its own answer must carry, and can add one
 * rule of its own. The click, the wait, the success class, the log line and
 * the dumped page on failure are the same for every provider.
 */
export const testProviderConnection = async (
  session: BrowserSession,
  provider: ProviderName,
  check: ConnectionCheck,
): Promise<void> => {
  const result = session.page.locator(`#${provider}-test-result`);
  await session.page.evaluate((id) => {
    const button = document.getElementById(id);
    if (button) button.click();
  }, `${provider}-test-btn`);
  await result.waitFor({ state: "visible", timeout: config.navTimeoutMs });

  const text = await result.innerText();
  const missing = check.require.filter((line) => !text.includes(line));
  const alsoWrong = check.alsoWrong?.(text) ?? null;
  const succeeded = await result.evaluate((element) =>
    element.classList.contains("success"),
  );
  if (succeeded && missing.length === 0 && alsoWrong === null) {
    log(`  ${check.passed}`);
    return;
  }

  await session.dumpPage(`${provider}-connection-test-failed`);
  throw new Error(
    `The ${provider} connection test did not pass. ` +
      `Missing: ${missing.join(", ") || "none"}. ` +
      `${alsoWrong === null ? "" : `${alsoWrong}. `}Result:\n${text}`,
  );
};

/** The honest no-op cleanup for providers whose sandbox resources are all
 * append-only (payments, refunds) with nothing ephemeral to remove. */
export const noProviderCleanup = (): Promise<void> => Promise.resolve();
