// jscpd:ignore-start

import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { RefundProviderScript } from "./provider-script.ts";
import type { RefundWindows } from "./windows.ts";
// jscpd:ignore-end

/** One paid booking made through the public page in a refund-safety story. */
export interface SafetyBooking {
  readonly amount: number;
  readonly attendeeId: number;
  readonly listingId: number;
  readonly paymentReference: string;
  readonly sessionId: string;
  readonly who: string;
}

/** A rendered owner-only form kept before another account tries its address. */
export interface SavedOwnerForm {
  readonly attendeeId: number;
  readonly button: string;
  readonly html: string;
  readonly path: string;
  readonly values: Record<string, string>;
}

/** State shared only by the high-risk refund stories. */
export interface RefundSafetyState {
  readonly bookings: Map<string, SafetyBooking>;
  manager?: TestBrowser;
  managerAnswer?: number;
  moneyFault?: { restore(): Promise<void> };
  ownerContactCount: number;
  provider?: RefundProviderScript;
  savedRefund?: SavedOwnerForm;
  savedReview?: SavedOwnerForm;
  windows?: RefundWindows;
}

/** The safety story's state, made on first use and kept as one coherent value. */
export const refundSafety = (world: TicketsWorld): RefundSafetyState => {
  if (world.refundSafety === undefined) {
    world.refundSafety = {
      bookings: new Map(),
      ownerContactCount: 0,
    };
  }
  return world.refundSafety;
};

/** The paid booking a story made for one named person. */
export const safetyBooking = (
  world: TicketsWorld,
  who: string,
): SafetyBooking => {
  const booking = refundSafety(world).bookings.get(who);
  if (booking === undefined) {
    throw new Error(`The story has no paid booking for ${who}`);
  }
  return booking;
};

/** The provider script installed for this story. */
export const safetyProvider = (world: TicketsWorld): RefundProviderScript => {
  const provider = refundSafety(world).provider;
  if (provider === undefined) {
    throw new Error("The story has no refund provider script");
  }
  return provider;
};
