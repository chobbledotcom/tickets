/* jscpd:ignore-start */
import { APIError, SumUp } from "@sumup/sdk";
import * as v from "valibot";
import { toMajorUnits } from "#shared/currency.ts";
import { settings } from "#shared/db/settings.ts";
import { errorMessage } from "#shared/error-message.ts";
import {
  ErrorCode,
  type ErrorCodeType,
  logDebug,
  logError,
} from "#shared/logger.ts";
import type { PaymentCheckoutCreateSnapshot } from "#shared/payment-checkout.ts";
import {
  type CredentialCheck,
  createWithClient,
} from "#shared/payment-helpers.ts";
import {
  providerCurrencyBlock,
  SUMUP_CURRENCIES,
} from "#shared/payment-providers.ts";
import { getPaymentWebhookUrl } from "#shared/payment-webhook-url.ts";
import {
  makeProviderTransportReader,
  type ProviderTransportResult,
  transportIssueForError,
} from "#shared/provider-transport.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  parseCreatedSumupCheckout,
  parseSumupCheckout,
  parseSumupTransaction,
  type SumupCheckout,
  type SumupCheckoutResult,
  type SumupTransaction,
} from "#shared/sumup/boundary.ts";

/* jscpd:ignore-end */

const SumupCurrencySchema = v.picklist(SUMUP_CURRENCIES);

export type {
  SumupCheckout,
  SumupTransaction,
} from "#shared/sumup/boundary.ts";

export type SumupReadResult<Value> = ProviderTransportResult<Value>;

export type SumupRefundRequestResult =
  | { status: "accepted" }
  | { status: "missing" }
  | { status: "rejected" }
  | { status: "unavailable" };

export type SumupConnectionTestResult = {
  ok: boolean;
  apiKey: CredentialCheck;
  merchant: { configured: boolean; merchantCode?: string; error?: string };
  currency: { code: string; supported: boolean };
};

const getClientImpl = (): SumUp | null => {
  const apiKey = settings.sumup.apiKey;
  if (!apiKey) {
    logDebug("SumUp", "No API key configured, cannot create client");
    return null;
  }
  return new SumUp({ apiKey });
};

const withClient = createWithClient(() => sumupApi.getSumupClient(), {
  shouldPropagate: (error) => error instanceof v.ValiError,
});

const readSumupTransport = makeProviderTransportReader<
  SumUp,
  never,
  ErrorCodeType
>({
  classifyError: (error) => {
    if (error instanceof v.ValiError) return "propagate";
    return transportIssueForError(
      error,
      (caught) => caught instanceof APIError && caught.status === 404,
      "unavailable",
    );
  },
  getClient: () => sumupApi.getSumupClient(),
  reportError: (error, code) =>
    logError({
      code,
      detail: error instanceof Error ? error.message : "unknown",
    }),
});

const getMerchantCode = (): string | null => {
  const merchantCode = settings.sumup.merchantCode;
  if (!merchantCode) {
    logError({ code: ErrorCode.CONFIG_MISSING, detail: "SumUp merchant code" });
    return null;
  }
  return merchantCode;
};

const sumupKeyError = (err: unknown): string => {
  const message = errorMessage(err);
  return message.startsWith("401")
    ? '401 Unauthorized — SumUp rejected this API key. The most common cause is using the wrong key: the "Public API key" shown on the SumUp dashboard will not work here. You need a secret API key — create one under For Developers → API Keys (https://me.sumup.com/en-gb/settings/api-keys), then copy the key it shows you, which is only displayed once. If you are already using a secret key, check it was copied in full and that the API key and Merchant Code belong to the same SumUp account (a sandbox key will not work with a live merchant code, or vice-versa).'
    : message;
};

const unavailableSumupRead = <Value>(): SumupReadResult<Value> => ({
  status: "unavailable",
});

const readSumupResource = async <Value>(
  load: (client: SumUp) => Promise<Value>,
  errorCode: ErrorCodeType,
): Promise<SumupReadResult<Value>> => readSumupTransport(load, errorCode);

const rejectedRefundStatuses = new Set([400, 403, 409, 422]);

const sumupRefundError = (
  error: unknown,
): Exclude<SumupRefundRequestResult, { status: "accepted" }> => {
  if (error instanceof APIError) {
    if (error.status === 404) return { status: "missing" };
    if (rejectedRefundStatuses.has(error.status)) return { status: "rejected" };
  }
  throw error;
};

const requestSumupRefund = async (
  transactionId: string,
): Promise<SumupRefundRequestResult> => {
  const merchantCode = getMerchantCode();
  if (merchantCode === null) return { status: "unavailable" };
  const result = await withClient(async (client) => {
    try {
      await client.transactions.refund(merchantCode, transactionId);
      return { status: "accepted" as const };
    } catch (error) {
      return sumupRefundError(error);
    }
  }, ErrorCode.PAYMENT_REFUND);
  return result ?? { status: "unavailable" };
};

export const sumupApi: {
  getSumupClient: () => SumUp | null;
  createCheckout: (
    checkout: PaymentCheckoutCreateSnapshot,
  ) => Promise<SumupCheckoutResult | null>;
  retrieveCheckoutById: (id: string) => Promise<SumupReadResult<SumupCheckout>>;
  refundTransaction: (
    transactionId: string,
  ) => Promise<SumupRefundRequestResult>;
  getTransactionStatus: (
    transactionId: string,
  ) => Promise<SumupReadResult<SumupTransaction>>;
  testSumupConnection: () => Promise<SumupConnectionTestResult>;
} = {
  createCheckout: async (
    checkout: PaymentCheckoutCreateSnapshot,
  ): Promise<SumupCheckoutResult | null> => {
    const merchantCode = getMerchantCode();
    if (!merchantCode) return null;
    const { baseUrl, bookingIntent, expected, localPaymentId } = checkout;

    return withClient(async (client) => {
      const created = await client.checkouts.create({
        amount: Number(toMajorUnits(expected.amount)),
        checkout_reference: localPaymentId,
        currency: v.parse(SumupCurrencySchema, expected.currency),
        description: `Tickets (${bookingIntent.items.length} listing(s))`,
        hosted_checkout: { enabled: true },
        merchant_code: merchantCode,
        redirect_url: `${baseUrl}/payment/success?session_id=${localPaymentId}`,
        return_url: getPaymentWebhookUrl(),
      });
      return parseCreatedSumupCheckout(created, {
        amount: expected,
        merchantCode,
        reference: localPaymentId,
      });
    }, ErrorCode.PAYMENT_CHECKOUT);
  },

  getSumupClient: getClientImpl,

  getTransactionStatus: (
    transactionId: string,
  ): Promise<SumupReadResult<SumupTransaction>> => {
    const merchantCode = getMerchantCode();
    if (merchantCode === null) {
      return Promise.resolve(unavailableSumupRead());
    }
    return readSumupResource(
      async (client) =>
        parseSumupTransaction(
          await client.transactions.get(merchantCode, { id: transactionId }),
          transactionId,
        ),
      ErrorCode.PAYMENT_SESSION,
    );
  },

  refundTransaction: requestSumupRefund,

  retrieveCheckoutById: (id: string): Promise<SumupReadResult<SumupCheckout>> =>
    readSumupResource(
      async (client) => parseSumupCheckout(await client.checkouts.get(id), id),
      ErrorCode.PAYMENT_SESSION,
    ),

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

    const client = requireValue(
      sumupApi.getSumupClient(),
      "SumUp client missing after API key validation",
    );
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
