import type { PaymentProviderType } from "#shared/types.ts";

/** Physical provider calls reserved before starting one stage recovery attempt. */
export const CHECKOUT_RECOVERY_EXTERNAL_CALLS = {
  square: 5,
  stripe: 9,
  sumup: 4,
} as const satisfies Record<PaymentProviderType, number>;

export const MAX_CHECKOUT_RECOVERY_EXTERNAL_CALLS = Math.max(
  ...Object.values(CHECKOUT_RECOVERY_EXTERNAL_CALLS),
);
