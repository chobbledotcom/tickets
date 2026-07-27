import {
  bindLegacyPaymentResource,
  getLegacyPaymentsByResource,
  type LegacyPaymentReplay,
  recordLegacyMappingAmbiguity,
} from "#shared/db/payments/legacy-sessions.ts";
import {
  getPaymentSessionByResourceOrNullPrimary,
  getPaymentSessionsPrimary,
} from "#shared/db/payments/sessions.ts";
import type { PaymentSession } from "#shared/db/payments/types.ts";
import { PAYMENT_PROVIDER_RESOURCES } from "#shared/payment-runtime/current.ts";
import { promoteLegacySumupPayment } from "#shared/payment-runtime/legacy-sumup.ts";
import type {
  ProviderResource,
  ProviderSessionResource,
} from "#shared/payment-state/resources.ts";
import type { PaymentProviderType } from "#shared/types.ts";

export type PaymentLocator =
  | { kind: "local"; id: string }
  | { kind: "provider"; resource: ProviderResource };

export interface LocatedPayment {
  conflict: boolean;
  legacy: LegacyPaymentReplay | null;
  payment: PaymentSession | null;
  requested: ProviderResource | null;
}

export interface LegacyPaymentMatch {
  conflict: boolean;
  legacy: LegacyPaymentReplay | null;
}

const sessionResourceFor = (
  resource: ProviderResource,
): ProviderSessionResource =>
  resource.kind === "stripe_checkout_session" ||
  resource.kind === "square_order" ||
  resource.kind === "sumup_checkout"
    ? resource
    : PAYMENT_PROVIDER_RESOURCES[resource.provider].session(resource.parentId);

export const matchLegacyPayment = async (
  payments: LegacyPaymentReplay[],
  resource: ProviderSessionResource,
): Promise<LegacyPaymentMatch> => {
  if (payments.length > 1) {
    await recordLegacyMappingAmbiguity(payments, resource);
    return { conflict: true, legacy: null };
  }
  const payment = payments[0];
  if (payment === undefined) return { conflict: false, legacy: null };
  if (payment.provider !== null && payment.provider !== resource.provider) {
    throw new Error(
      `Legacy payment ${payment.id} belongs to ${payment.provider}, not ${resource.provider}`,
    );
  }
  return {
    conflict: false,
    legacy: await bindLegacyPaymentResource(payment, resource),
  };
};

export const locatePayment = async (
  provider: PaymentProviderType,
  locator: PaymentLocator,
): Promise<LocatedPayment> => {
  if (locator.kind === "provider") {
    const resource = locator.resource;
    const sessionResource = sessionResourceFor(resource);
    const payment =
      await getPaymentSessionByResourceOrNullPrimary(sessionResource);
    if (payment !== null) {
      return { conflict: false, legacy: null, payment, requested: resource };
    }
    const located = await matchLegacyPayment(
      await getLegacyPaymentsByResource(sessionResource),
      sessionResource,
    );
    return {
      ...located,
      payment: null,
      requested: resource,
    };
  }
  const [stored] = await getPaymentSessionsPrimary([locator.id]);
  if (stored !== null && stored !== undefined) {
    return {
      conflict: false,
      legacy: null,
      payment: stored,
      requested: stored.session,
    };
  }
  const promoted =
    provider === "sumup" ? await promoteLegacySumupPayment(locator.id) : null;
  if (promoted === null) {
    return { conflict: false, legacy: null, payment: null, requested: null };
  }
  if ("conflict" in promoted) {
    return { conflict: true, legacy: null, payment: null, requested: null };
  }
  if ("legacy" in promoted) {
    return {
      conflict: false,
      legacy: promoted.legacy,
      payment: null,
      requested: promoted.resource,
    };
  }
  return {
    conflict: false,
    legacy: null,
    payment: promoted.payment,
    requested: promoted.payment.session,
  };
};
