/**
 * SumUp integration module for ticket payments.
 * Uses the official @sumup/sdk typed client (fetch-based, edge-compatible).
 *
 * SumUp flow differs from Stripe/Square:
 * - Checkout uses SumUp Hosted Checkout (hosted_checkout.enabled = true)
 * - Checkouts carry no arbitrary metadata, so booking metadata is stored
 *   locally (db/sumup-checkouts.ts) keyed by our generated checkout_reference
 * - Webhooks are unsigned: listings are pre-filtered against our staging rows,
 *   then authenticity comes from re-fetching the checkout
 * - Refunds operate on the transaction id (paymentReference), not the checkout
 *
 * A fetched checkout is checked against our independent facts and normalized
 * by the pure sumup-observation module; this module only owns the client and
 * tells an authoritative not-found apart from SumUp being unreachable.
 */

/* jscpd:ignore-start */
import type { Currency } from "@sumup/sdk";
import { APIError, SumUp } from "@sumup/sdk";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { settings } from "#shared/db/settings.ts";
import {
  setSumupCheckoutId,
  storeSumupCheckout,
} from "#shared/db/sumup-checkouts.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import type { ProviderRead } from "#shared/payment/provider-read.ts";
import {
  assembleCheckoutMetadata,
  type CredentialCheck,
  createWithClient,
} from "#shared/payment-helpers.ts";
import { providerCurrencyBlock } from "#shared/payment-providers.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import {
  classifySumupCheckout,
  type SumupCheckout,
} from "#shared/sumup-observation.ts";

/* jscpd:ignore-end */

/** Result of creating a hosted checkout. */
export type SumupCheckoutResult = { reference: string; url: string } | null;

/** Result of testing the SumUp connection. */
export type SumupConnectionTestResult = {
  ok: boolean;
  apiKey: CredentialCheck;
  merchant: { configured: boolean; merchantCode?: string; error?: string };
  currency: { code: string; supported: boolean };
};

/** Internal getSumupClient implementation — reads the current API key. */
const getClientImpl = (): SumUp | null => {
  const apiKey = settings.sumup.apiKey;
  if (!apiKey) {
    logDebug("SumUp", "No API key configured, cannot create client");
    return null;
  }
  return new SumUp({ apiKey });
};

/** Run an operation with the SumUp client, returning null if unavailable. */
const withClient = createWithClient(() => sumupApi.getSumupClient());

/** Resolve the configured merchant code, logging if absent. */
const getMerchantCode = (): string | null => {
  const merchantCode = settings.sumup.merchantCode;
  if (!merchantCode) {
    logError({ code: ErrorCode.CONFIG_MISSING, detail: "SumUp merchant code" });
    return null;
  }
  return merchantCode;
};

/**
 * Turn a failed merchant lookup into an actionable connection-test message.
 *
 * SumUp answers the merchant lookup with a 401 whenever it rejects the API key.
 * The most common cause is pasting the wrong key: the dashboard prominently
 * shows a "Public API key", but checkouts need a *secret* API key created under
 * For Developers → API Keys (shown only once). Less commonly the key was
 * truncated on paste, or the key and merchant code belong to different accounts
 * (e.g. a sandbox key with a live merchant code). The raw SumUp body is just an
 * opaque trace id, so for a 401 we replace it with guidance and pass other
 * errors (network failures, 5xx, etc.) through unchanged.
 */
const sumupKeyError = (err: unknown): string => {
  const message = errorMessage(err);
  return message.startsWith("401")
    ? '401 Unauthorized — SumUp rejected this API key. The most common cause is using the wrong key: the "Public API key" shown on the SumUp dashboard will not work here. You need a secret API key — create one under For Developers → API Keys (https://me.sumup.com/en-gb/settings/api-keys), then copy the key it shows you, which is only displayed once. If you are already using a secret key, check it was copied in full and that the API key and Merchant Code belong to the same SumUp account (a sandbox key will not work with a live merchant code, or vice-versa).'
    : message;
};

/** Turn a failed checkout fetch into the read it proves. The SDK's APIError
 *  carries the HTTP status, so an authoritative not-found is told apart from
 *  SumUp being unreachable; the status code is safe to log, the body is not. */
const sumupReadFailure = (err: unknown): ProviderRead<SumupCheckout> => {
  if (err instanceof APIError) {
    logDebug("SumUp", `Checkout read answered ${err.status}`);
    return err.status === 404
      ? { status: "missing" }
      : { reason: "provider_error", status: "unavailable" };
  }
  logDebug("SumUp", "Checkout read failed before SumUp answered");
  return { reason: "network_error", status: "unavailable" };
};

/**
 * Stubbable API for testing — mirrors stripeApi/squareApi so the provider
 * adapter and tests can mock these methods directly.
 */
export const sumupApi: {
  getSumupClient: () => SumUp | null;
  createCheckout: (
    intent: CheckoutIntent,
    baseUrl: string,
  ) => Promise<SumupCheckoutResult>;
  readCheckoutById: (id: string) => Promise<ProviderRead<SumupCheckout>>;
  refundTransaction: (transactionId: string) => Promise<boolean>;
  getTransactionStatus: (transactionId: string) => Promise<string | null>;
  testSumupConnection: () => Promise<SumupConnectionTestResult>;
} = {
  /** Create a hosted checkout and persist booking metadata under its reference. */
  createCheckout: async (
    intent: CheckoutIntent,
    baseUrl: string,
  ): Promise<SumupCheckoutResult> => {
    const merchantCode = getMerchantCode();
    if (!merchantCode) return null;

    // Price the order once and reuse that total for both the signed proof
    // (stored in metadata) and the amount charged below, so the two can never
    // disagree even if pricing settings change mid-checkout (see #1300).
    const totalMinor = priceCheckout(intent).total;

    // Persist metadata before creating the checkout so it is present when the
    // webhook or redirect arrives. An orphaned row (if create fails) is pruned.
    const reference = crypto.randomUUID();
    // SumUp carries no provider metadata: the booking fields are stored locally
    // (db/sumup-checkouts.ts), so its registry caps are unbounded and the
    // operator's thank_you_url is always retained.
    await storeSumupCheckout(
      reference,
      await assembleCheckoutMetadata("sumup", intent, totalMinor),
    );

    return withClient(async (client) => {
      const checkout = await client.checkouts.create({
        amount: Number(toMajorUnits(totalMinor)),
        checkout_reference: reference,
        currency: settings.currency.toUpperCase() as Currency,
        description: `Tickets (${intent.items.length} listing(s))`,
        hosted_checkout: { enabled: true },
        merchant_code: merchantCode,
        redirect_url: `${baseUrl}/payment/success?session_id=${reference}`,
        return_url: getPaymentWebhookUrl(),
      });
      const url = checkout.hosted_checkout_url;
      if (!checkout.id || !url) {
        logDebug(
          "SumUp",
          "Checkout response missing id or hosted_checkout_url",
        );
        return null;
      }
      // Record the SumUp id so webhooks for this checkout pass the pre-filter
      // and the redirect can fetch it directly. Runs before the customer ever
      // sees the payment URL, so no webhook can race it.
      await setSumupCheckoutId(reference, checkout.id);
      // Logged so the payment-sandbox e2e can deliver this checkout's own
      // callback; Square logs its created orderId the same way.
      logDebug("SumUp", `Checkout created id=${checkout.id}`);
      return { reference, url };
    }, ErrorCode.PAYMENT_CHECKOUT);
  },

  getSumupClient: getClientImpl,

  /** Read a transaction's high-level status (e.g. for refund checks). */
  getTransactionStatus: (transactionId: string): Promise<string | null> => {
    const merchantCode = getMerchantCode();
    if (!merchantCode) return Promise.resolve(null);
    return withClient(async (client) => {
      const txn = await client.transactions.get(merchantCode, {
        id: transactionId,
      });
      return txn.status ?? null;
    }, ErrorCode.PAYMENT_SESSION);
  },

  /** Read a checkout by its SumUp id and check it against our facts. */
  readCheckoutById: async (
    id: string,
  ): Promise<ProviderRead<SumupCheckout>> => {
    const client = sumupApi.getSumupClient();
    const merchantCode = getMerchantCode();
    if (!client || !merchantCode) {
      return { reason: "not_configured", status: "unavailable" };
    }
    // Only the fetch is guarded: the classifier is pure, so anything it
    // throws (Intl refusing a misconfigured site currency) is our own fault
    // and must surface loudly, never dress up as SumUp being unreachable.
    let body: unknown;
    try {
      body = await client.checkouts.get(id);
    } catch (err) {
      return sumupReadFailure(err);
    }
    return classifySumupCheckout(body, {
      merchantCode,
      requestedId: id,
      siteCurrency: settings.currency,
    });
  },

  /** Refund a transaction in full. */
  refundTransaction: async (transactionId: string): Promise<boolean> => {
    const merchantCode = getMerchantCode();
    if (!merchantCode) return false;
    const result = await withClient(async (client) => {
      await client.transactions.refund(merchantCode, transactionId);
      return true;
    }, ErrorCode.PAYMENT_REFUND);
    return result ?? false;
  },

  /** Test connection: verify API key + merchant code + currency support. */
  testSumupConnection: async (): Promise<SumupConnectionTestResult> => {
    const currencyCode = settings.currency.toUpperCase();
    const result: SumupConnectionTestResult = {
      apiKey: { valid: false },
      currency: {
        code: currencyCode,
        supported: providerCurrencyBlock("sumup", currencyCode) === null,
      },
      merchant: { configured: false },
      ok: false,
    };

    if (!settings.sumup.apiKey) {
      result.apiKey.error = "No SumUp API key configured";
      return result;
    }
    const merchantCode = settings.sumup.merchantCode;
    if (!merchantCode) {
      result.apiKey.error = "Merchant code is required to verify the key";
      result.merchant.error = "No merchant code configured";
      return result;
    }

    // Non-null: the API key was verified present just above
    const client = sumupApi.getSumupClient()!;
    try {
      await client.merchants.get(merchantCode);
      result.apiKey = {
        mode: settings.sumup.keyMode ?? "unknown",
        valid: true,
      };
      result.merchant = { configured: true, merchantCode };
      result.ok = result.currency.supported;
    } catch (err) {
      result.apiKey = { error: sumupKeyError(err), valid: false };
    }
    return result;
  },
};
