import { settings } from "#shared/db/settings.ts";
import { existingPaymentProviderState } from "#shared/existing-payment-provider.ts";
import { logDebug } from "#shared/logger.ts";
import type { PaymentProvider, PaymentProviderType } from "#shared/payments.ts";

type AttemptOperations = Pick<
  PaymentProvider,
  | "checkoutCompletedEventType"
  | "isPaymentRefunded"
  | "refundPayment"
  | "requiresWebhookSignature"
  | "resolveWebhookSession"
  | "retrieveSession"
  | "type"
  | "verifyWebhookSignature"
>;

/** One immutable provider selection used from observation through settlement. */
export interface PaymentAttempt extends AttemptOperations {
  readonly currency: string;
}

export type PaymentAttemptConfig =
  | {
      readonly currency: string;
      readonly keyMode: "live" | "test" | null;
      readonly secretKey: string;
      readonly type: "stripe";
      readonly webhookSecret: string;
    }
  | {
      readonly accessToken: string;
      readonly currency: string;
      readonly locationId: string;
      readonly sandbox: boolean;
      readonly type: "square";
      readonly webhookSignatureKey: string;
    }
  | {
      readonly apiKey: string;
      readonly currency: string;
      readonly merchantCode: string;
      readonly type: "sumup";
    };

const configFor = (
  type: PaymentProviderType,
  currency: string,
): PaymentAttemptConfig => {
  switch (type) {
    case "stripe":
      return {
        currency,
        keyMode: settings.stripe.keyMode,
        secretKey: settings.stripe.secretKey,
        type,
        webhookSecret: settings.stripe.webhookSecret,
      };
    case "square":
      return {
        accessToken: settings.square.accessToken,
        currency,
        locationId: settings.square.locationId,
        sandbox: settings.square.sandbox,
        type,
        webhookSignatureKey: settings.square.webhookSignatureKey,
      };
    case "sumup":
      return {
        apiKey: settings.sumup.apiKey,
        currency,
        merchantCode: settings.sumup.merchantCode,
        type,
      };
  }
};

const bind = async (config: PaymentAttemptConfig): Promise<PaymentAttempt> => {
  switch (config.type) {
    case "stripe":
      return (
        await import("#shared/stripe-provider.ts")
      ).createStripePaymentAttempt(config);
    case "square":
      return (
        await import("#shared/square-provider.ts")
      ).createSquarePaymentAttempt(config);
    case "sumup":
      return (
        await import("#shared/sumup-provider.ts")
      ).createSumupPaymentAttempt(config);
  }
};

/** Stubbable provider-binding boundary used after the settings snapshot. */
export const paymentAttemptApi = { bind };

export const getExistingPaymentAttempt =
  async (): Promise<PaymentAttempt | null> => {
    const type = existingPaymentProviderState(
      settings.paymentProvider,
    ).provider;
    if (!type) return null;
    logDebug(
      "Payment",
      `Binding payment attempt for existing payment: ${type}`,
    );
    const config = configFor(type, settings.currency.toUpperCase());
    return paymentAttemptApi.bind(config);
  };
