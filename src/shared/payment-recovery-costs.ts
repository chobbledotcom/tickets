import type { CheckoutStageState } from "#shared/db/checkout-stages.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/** Database calls reserved before starting one stage recovery attempt. */
export const CHECKOUT_RECOVERY_DATABASE_CALLS = {
  paid: 22,
  pending: 5,
  refunding: 23,
} as const satisfies Record<CheckoutStageState, number>;

const CHECKOUT_RECOVERY_SELECTION_DATABASE_CALLS = 1;
export const CHECKOUT_RECOVERY_FOLLOW_UP_DATABASE_CALLS = 1;

export const MAX_CHECKOUT_RECOVERY_DATABASE_CALLS =
  CHECKOUT_RECOVERY_SELECTION_DATABASE_CALLS +
  CHECKOUT_RECOVERY_FOLLOW_UP_DATABASE_CALLS +
  Math.max(...Object.values(CHECKOUT_RECOVERY_DATABASE_CALLS));

/** Physical provider calls reserved before starting one stage recovery attempt. */
export const CHECKOUT_RECOVERY_EXTERNAL_CALLS = {
  square: 5,
  stripe: 9,
  sumup: 4,
} as const satisfies Record<PaymentProviderType, number>;

export const MAX_CHECKOUT_RECOVERY_EXTERNAL_CALLS = Math.max(
  ...Object.values(CHECKOUT_RECOVERY_EXTERNAL_CALLS),
);
