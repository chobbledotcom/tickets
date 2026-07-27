import type {
  ProviderChargeResource,
  ProviderRefundResource,
  ProviderSessionResource,
} from "#shared/payment-state/resources.ts";
import type { PaymentProviderType } from "#shared/types.ts";

type ResourceBuilders = {
  charge: (id: string, parentId: string) => ProviderChargeResource;
  refund: (id: string, parentId: string) => ProviderRefundResource;
  session: (id: string) => ProviderSessionResource;
};

export const PAYMENT_PROVIDER_RESOURCES: Record<
  PaymentProviderType,
  ResourceBuilders
> = {
  square: {
    charge: (id, parentId) => ({
      id,
      kind: "square_payment",
      parentId,
      provider: "square",
    }),
    refund: (id, parentId) => ({
      id,
      kind: "square_refund",
      parentId,
      provider: "square",
    }),
    session: (id) => ({ id, kind: "square_order", provider: "square" }),
  },
  stripe: {
    charge: (id, parentId) => ({
      id,
      kind: "stripe_payment_intent",
      parentId,
      provider: "stripe",
    }),
    refund: (id, parentId) => ({
      id,
      kind: "stripe_refund",
      parentId,
      provider: "stripe",
    }),
    session: (id) => ({
      id,
      kind: "stripe_checkout_session",
      provider: "stripe",
    }),
  },
  sumup: {
    charge: (id, parentId) => ({
      id,
      kind: "sumup_transaction",
      parentId,
      provider: "sumup",
    }),
    refund: (id, parentId) => ({
      id,
      kind: "sumup_refund",
      parentId,
      provider: "sumup",
    }),
    session: (id) => ({ id, kind: "sumup_checkout", provider: "sumup" }),
  },
};
