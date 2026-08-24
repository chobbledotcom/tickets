/**
 * SumUp integration module for ticket payments.
 * Every call goes through the shared provider boundary in
 * `#payment/provider-fetch.ts`, so each one carries the provider timeout and
 * counts against the edge subrequest budget.
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

import { settings } from "#db/settings.ts";
import { setSumupCheckoutId, storeSumupCheckout } from "#db/sumup-checkouts.ts";
import { closedCheckoutErrorFor } from "#payment/checkout-failure.ts";
import type { ProviderRead } from "#payment/provider-read.ts";
import {
  providerResourceReader,
  type ResourceReader,
} from "#payment/provider-resource-read.ts";
import { transportFactsOf } from "#payment/transport-error.ts";
/* jscpd:ignore-start */
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { toMajorUnits } from "#shared/currency.ts";
import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import {
  assembleCheckoutMetadata,
  type CredentialCheck,
  createWithClient,
} from "#shared/payment-helpers.ts";
import { providerCurrencyBlock } from "#shared/payment-providers.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import {
  type SumupRefundSubmission,
  sumupReadFailure,
  sumupRefundFailure,
} from "#shared/sumup/failures.ts";
import {
  readSumupTransaction,
  type SumupTransactionMoney,
} from "#shared/sumup/transaction.ts";
import {
  createSumupTransport,
  type SumupTransport,
} from "#shared/sumup/transport.ts";
import { readCreatedSumupCheckout } from "#shared/sumup/wire.ts";
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

type SumupClient = SumupTransport;

/** Internal getSumupClient implementation — reads the current API key. */
const getClientImpl = (): SumupClient | null => {
  const apiKey = settings.sumup.apiKey;
  if (!apiKey) {
    logDebug("SumUp", "No API key configured, cannot create client");
    return null;
  }
  return createSumupTransport(apiKey);
};

/** Run checkout with the configured client. Missing configuration is a normal
 * absence; a failed provider call is an unexpected booking failure. */
const withCheckoutClient = createWithClient(() => sumupApi.getSumupClient(), {
  replaceError: closedCheckoutErrorFor("sumup"),
});

/** Resolve the configured merchant code, logging if absent. */
const getMerchantCode = (): string | null => {
  const merchantCode = settings.sumup.merchantCode;
  if (!merchantCode) {
    logError({ code: ErrorCode.CONFIG_MISSING, detail: "SumUp merchant code" });
    return null;
  }
  return merchantCode;
};

type SumupAccount = { client: SumupClient; merchantCode: string };

/** Resolve the two account facts every authenticated SumUp call needs. */
const configuredSumupAccount = (): SumupAccount | null => {
  const client = sumupApi.getSumupClient();
  const merchantCode = getMerchantCode();
  return client === null || merchantCode === null
    ? null
    : { client, merchantCode };
};

/** Read one SumUp resource for the configured account. */
const readSumupResource = (
  resourceName: string,
): ResourceReader<SumupAccount> =>
  providerResourceReader(configuredSumupAccount, (err) =>
    sumupReadFailure(resourceName, err),
  );

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
const SUMUP_KEY_REJECTED =
  '401 Unauthorized — SumUp rejected this API key. The most common cause is using the wrong key: the "Public API key" shown on the SumUp dashboard will not work here. You need a secret API key — create one under For Developers → API Keys (https://me.sumup.com/en-gb/settings/api-keys), then copy the key it shows you, which is only displayed once. If you are already using a secret key, check it was copied in full and that the API key and Merchant Code belong to the same SumUp account (a sandbox key will not work with a live merchant code, or vice-versa).';

const sumupKeyError = (err: unknown): string =>
  transportFactsOf(err)?.statusCode === 401
    ? SUMUP_KEY_REJECTED
    : errorMessage(err);

/**
 * Stubbable API for testing — mirrors stripeApi/squareApi so the provider
 * adapter and tests can mock these methods directly.
 */
export const sumupApi: {
  getSumupClient: () => SumupClient | null;
  createCheckout: (
    intent: CheckoutIntent,
    baseUrl: string,
  ) => Promise<SumupCheckoutResult>;
  readCheckoutById: (id: string) => Promise<ProviderRead<SumupCheckout>>;
  refundTransaction: (transactionId: string) => Promise<SumupRefundSubmission>;
  readTransactionMoney: (
    transactionId: string,
  ) => Promise<ProviderRead<SumupTransactionMoney>>;
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

    return withCheckoutClient(async (client) => {
      const checkout = readCreatedSumupCheckout(
        await client.createCheckout({
          amount: Number(toMajorUnits(totalMinor)),
          checkout_reference: reference,
          currency: settings.currency.toUpperCase(),
          description: `Tickets (${intent.items.length} listing(s))`,
          hosted_checkout: { enabled: true },
          merchant_code: merchantCode,
          redirect_url: `${baseUrl}/payment/success?session_id=${reference}`,
          return_url: getPaymentWebhookUrl(),
        }),
      );
      const url = checkout.hosted_checkout_url;
      if (!checkout.id) {
        throw new Error("SumUp checkout response is missing its id");
      }
      if (!url) {
        throw new Error("SumUp checkout response is missing its hosted URL");
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

  /** Read a checkout by its SumUp id and check it against our facts. */
  readCheckoutById: (id: string): Promise<ProviderRead<SumupCheckout>> =>
    readSumupResource("Checkout")(
      (account) => account.client.readCheckout(id),
      (body, account) =>
        classifySumupCheckout(body, {
          merchantCode: account.merchantCode,
          requestedId: id,
          siteCurrency: settings.currency,
        }),
    ),

  /**
   * Read what a transaction says about its money: the total it took, and every
   * refund SumUp has recorded against it. SumUp keeps no refund records of its
   * own — a refund is an event on the transaction that took the money — so the
   * events are the only account of what has gone back.
   */
  readTransactionMoney: (
    transactionId: string,
  ): Promise<ProviderRead<SumupTransactionMoney>> =>
    readSumupResource("Transaction")(
      (account) =>
        account.client.readTransaction(account.merchantCode, {
          id: transactionId,
        }),
      (body, account) =>
        readSumupTransaction(body, {
          merchantCode: account.merchantCode,
          transactionId,
        }),
    ),

  /** Submit a full refund without overstating SumUp's empty success body. */
  refundTransaction: async (
    transactionId: string,
  ): Promise<SumupRefundSubmission> => {
    const account = configuredSumupAccount();
    if (account === null) return { kind: "not_sent", reason: "not_configured" };
    try {
      await account.client.refundTransaction(
        account.merchantCode,
        transactionId,
      );
      return { kind: "sent" };
    } catch (err) {
      return sumupRefundFailure(err);
    }
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

    const client = sumupApi.getSumupClient();
    if (client === null) {
      throw new Error("Configured SumUp API key did not create a client");
    }
    try {
      await client.readMerchant(merchantCode);
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
