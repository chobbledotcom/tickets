import { DAY_MS } from "#shared/now.ts";
import type { PaymentProviderType } from "#shared/types.ts";

type ReplayWindowPolicy = (now: number) => number;

const REPLAY_WINDOW_BY_PROVIDER = {
  square: (now: number): number => now,
  stripe: (now: number): number => now + DAY_MS,
  sumup: (_now: number): number => {
    throw new Error("SumUp refunds have no keyed replay window");
  },
} satisfies Record<PaymentProviderType, ReplayWindowPolicy>;

/** End of the provider's documented exact-key replay window. A provider with
 * no keyed request authority is refused instead of receiving a made-up one. */
export const refundReplayUntil = (
  provider: PaymentProviderType,
  now: number,
): number => {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("Refund replay time must be a non-negative safe integer");
  }
  return REPLAY_WINDOW_BY_PROVIDER[provider](now);
};
