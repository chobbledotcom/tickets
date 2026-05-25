/**
 * SumUp integration module for ticket payments.
 * Uses the official @sumup/sdk typed client (fetch-based, edge-compatible).
 *
 * SumUp flow differs from Stripe/Square:
 * - Checkout uses SumUp Hosted Checkout (hosted_checkout.enabled = true)
 * - Checkouts carry no arbitrary metadata, so booking metadata is stored
 *   locally (db/sumup-checkouts.ts) keyed by our generated checkout_reference
 * - Webhooks are unsigned: authenticity comes from re-fetching the checkout
 * - The webhook only carries a checkout id; the redirect carries our reference
 * - Refunds operate on the transaction id (paymentReference), not the checkout
 *
 * Amounts: the app models money in minor units (e.g. pence); SumUp's API uses
 * major units. We convert at the boundary, assuming 2-decimal currencies (the
 * same assumption the rest of the money handling makes).
 */

import { SumUp } from "@sumup/sdk";
import type { CheckoutSuccess, Currency } from "@sumup/sdk";
import { getBookingFeeAmount, itemsSubtotal } from "#shared/booking-fee.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { settings } from "#shared/db/settings.ts";
import { storeSumupCheckout } from "#shared/db/sumup-checkouts.ts";
import { ErrorCode, logDebug, logError } from "#shared/logger.ts";
import {
  buildItemsMetadata,
  type CredentialCheck,
  createWithClient,
  errorMessage,
} from "#shared/payment-helpers.ts";
import type { CheckoutIntent } from "#shared/payments.ts";

/** Minor units (e.g. pence) per major unit. Assumes 2-decimal currencies. */
const MINOR_PER_MAJOR = 100;

/** Convert minor units (pence) to the major units SumUp's API expects. */
const toMajorUnits = (minor: number): number => minor / MINOR_PER_MAJOR;

/** Convert SumUp's major-unit amount back to the app's minor units. */
const toMinorUnits = (major: number): number =>
  Math.round(major * MINOR_PER_MAJOR);

/** Normalized checkout shape consumed by the provider adapter. */
export type SumupCheckout = {
  /** Our generated checkout_reference — used as the session id throughout. */
  reference: string;
  /** SumUp checkout lifecycle status. */
  status: CheckoutSuccess["status"];
  /** Total amount in the app's minor units. */
  amountMinor: number;
  /** Transaction id of the completing payment (refund/payment reference). */
  transactionId: string;
};

/** Result of creating a hosted checkout. */
export type SumupCheckoutResult = { reference: string; url: string } | null;

/** Result of testing the SumUp connection. */
export type SumupConnectionTestResult = {
  ok: boolean;
  apiKey: CredentialCheck;
  merchant: { configured: boolean; merchantCode?: string; error?: string };
};

/** Construct a SumUp client (no network on construction). */
const createSumupClient = (apiKey: string): SumUp => new SumUp({ apiKey });

/** Internal getSumupClient implementation — reads the current API key. */
const getClientImpl = (): SumUp | null => {
  const apiKey = settings.sumup.apiKey;
  if (!apiKey) {
    logDebug("SumUp", "No API key configured, cannot create client");
    return null;
  }
  return createSumupClient(apiKey);
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

/** Normalize a SumUp checkout resource into our internal shape. */
const toSumupCheckout = (c: CheckoutSuccess): SumupCheckout => ({
  amountMinor: typeof c.amount === "number" ? toMinorUnits(c.amount) : 0,
  reference: c.checkout_reference ?? "",
  status: c.status,
  transactionId: c.transaction_id ?? c.transactions?.[0]?.id ?? "",
});

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
  retrieveCheckoutByReference: (
    reference: string,
  ) => Promise<SumupCheckout | null>;
  retrieveCheckoutById: (id: string) => Promise<SumupCheckout | null>;
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

    // Persist metadata before creating the checkout so it is present when the
    // webhook or redirect arrives. An orphaned row (if create fails) is pruned.
    const reference = crypto.randomUUID();
    await storeSumupCheckout(reference, await buildItemsMetadata(intent));

    const subtotal = itemsSubtotal(intent.items);
    const totalMinor = subtotal + getBookingFeeAmount(subtotal);

    return withClient(async (client) => {
      const checkout = await client.checkouts.create({
        amount: toMajorUnits(totalMinor),
        checkout_reference: reference,
        currency: settings.currency.toUpperCase() as Currency,
        description: `Tickets (${intent.items.length} event(s))`,
        hosted_checkout: { enabled: true },
        merchant_code: merchantCode,
        redirect_url: `${baseUrl}/payment/success?session_id=${reference}`,
        return_url: `https://${getEffectiveDomain()}/payment/webhook`,
      });
      const url = checkout.hosted_checkout_url;
      if (!url) {
        logDebug("SumUp", "Checkout response missing hosted_checkout_url");
        return null;
      }
      return { reference, url };
    }, ErrorCode.PAYMENT_CHECKOUT);
  },

  getSumupClient: getClientImpl,

  /** Read a transaction's high-level status (e.g. for refund checks). */
  getTransactionStatus: (
    transactionId: string,
  ): Promise<string | null> => {
    const merchantCode = getMerchantCode();
    if (!merchantCode) return Promise.resolve(null);
    return withClient(async (client) => {
      const txn = await client.transactions.get(merchantCode, {
        id: transactionId,
      });
      return txn.status ?? null;
    }, ErrorCode.PAYMENT_SESSION);
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

  /** Retrieve a checkout by its SumUp id (used for webhook events). */
  retrieveCheckoutById: (id: string): Promise<SumupCheckout | null> =>
    withClient(
      async (client) => toSumupCheckout(await client.checkouts.get(id)),
      ErrorCode.PAYMENT_SESSION,
    ),

  /** Retrieve a checkout by our checkout_reference (used for redirects). */
  retrieveCheckoutByReference: (
    reference: string,
  ): Promise<SumupCheckout | null> =>
    withClient(async (client) => {
      const list = await client.checkouts.list({
        checkout_reference: reference,
      });
      const checkout = list[0];
      return checkout ? toSumupCheckout(checkout) : null;
    }, ErrorCode.PAYMENT_SESSION),

  /** Test connection: verify the API key + merchant code via merchants.get. */
  testSumupConnection: async (): Promise<SumupConnectionTestResult> => {
    const result: SumupConnectionTestResult = {
      apiKey: { valid: false },
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

    const client = await sumupApi.getSumupClient();
    if (!client) {
      result.apiKey.error = "No SumUp API key configured";
      return result;
    }

    try {
      const merchant = await client.merchants.get(merchantCode);
      result.apiKey = {
        mode: settings.sumup.keyMode ?? "unknown",
        valid: true,
      };
      result.merchant = {
        configured: true,
        merchantCode: merchant.merchant_code ?? merchantCode,
      };
      result.ok = true;
    } catch (err) {
      result.apiKey = { error: errorMessage(err), valid: false };
    }
    return result;
  },
};

// Wrapper exports for production code (delegate to sumupApi for test mocking)
export const createCheckout = (i: CheckoutIntent, b: string) =>
  sumupApi.createCheckout(i, b);
export const retrieveCheckoutByReference = (ref: string) =>
  sumupApi.retrieveCheckoutByReference(ref);
export const retrieveCheckoutById = (id: string) =>
  sumupApi.retrieveCheckoutById(id);
export const refundTransaction = (id: string) =>
  sumupApi.refundTransaction(id);
export const getTransactionStatus = (id: string) =>
  sumupApi.getTransactionStatus(id);
export const testSumupConnection = () => sumupApi.testSumupConnection();
