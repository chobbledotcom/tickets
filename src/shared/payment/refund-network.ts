import type { PaymentProviderType } from "#types";

/**
 * Transport retries inside one refund command, per provider.
 *
 * Every provider makes one attempt. Durable claims, stable keys, and a fresh
 * provider read own recovery, so a refund send never spends a second attempt
 * on the network — asking twice is how a keyless provider pays twice.
 *
 * The refund budget prices the provider calls one refund can make
 * (`src/features/admin/refunds/budget.ts`), so the count stays per provider:
 * a provider that ever needs another attempt raises its own row, and nobody
 * else's.
 */
export const REFUND_NETWORK_RETRIES = {
  square: 0,
  stripe: 0,
  sumup: 0,
} as const satisfies Record<PaymentProviderType, number>;
