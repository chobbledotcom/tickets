import { SQUARE_MAX_NETWORK_RETRIES } from "#shared/square/transport.ts";
import { SUMUP_MAX_NETWORK_RETRIES } from "#shared/sumup/transport.ts";
import type { PaymentProviderType } from "#shared/types.ts";

/** Transport retries inside one refund command. Durable claims, stable keys,
 * and a fresh provider read own recovery, so Stripe also makes one attempt. */
export const REFUND_NETWORK_RETRIES = {
  square: SQUARE_MAX_NETWORK_RETRIES,
  stripe: 0,
  sumup: SUMUP_MAX_NETWORK_RETRIES,
} as const satisfies Record<PaymentProviderType, number>;
