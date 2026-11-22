import {
  bookingReplay,
  doorScan,
} from "#scripts/model-guides/guides/booking.ts";
import { attendeeCapacity } from "#scripts/model-guides/guides/capacity.ts";
import { sharedGroupCapacity } from "#scripts/model-guides/guides/group-capacity.ts";
import { modalFocus } from "#scripts/model-guides/guides/modal-focus.ts";
import { modalLifecycle } from "#scripts/model-guides/guides/modal-lifecycle.ts";
import {
  jointState,
  refundReversal,
} from "#scripts/model-guides/guides/money-a.ts";
import {
  checkoutComposition,
  largestRemainderSplit,
} from "#scripts/model-guides/guides/money-checkout.ts";
import { squareLinkEnd } from "#scripts/model-guides/guides/money-square.ts";
import { vatLedger } from "#scripts/model-guides/guides/money-vat.ts";
import { paymentReview } from "#scripts/model-guides/guides/payment-review.ts";
import {
  invoiceFlow,
  notificationFlagLease,
} from "#scripts/model-guides/guides/records.ts";
import { modelRules } from "#scripts/model-guides/guides/rules.ts";
import { subscriptionCancellation } from "#scripts/model-guides/guides/subscriptions-cancellation.ts";
import {
  subscriptionCheckout,
  subscriptionRules,
} from "#scripts/model-guides/guides/subscriptions-checkout.ts";
import { subscriptionLifecycle } from "#scripts/model-guides/guides/subscriptions-lifecycle.ts";
import { subscriptionRecords } from "#scripts/model-guides/guides/subscriptions-records.ts";
import { subscriptionRenewals } from "#scripts/model-guides/guides/subscriptions-renewals.ts";
import { sumupRecovery } from "#scripts/model-guides/guides/sumup-recovery.ts";
import { twoWorkers } from "#scripts/model-guides/guides/two-workers.ts";
import type { ModelGuide } from "#scripts/model-guides/types.ts";

/* jscpd:ignore-start -- static data, not code */
/** Every maintained walkthrough, keyed by its module, in index order. */
const GUIDE_BY_MODULE = {
  AttendeeCapacity: attendeeCapacity,
  BookingReplay: bookingReplay,
  CheckoutComposition: checkoutComposition,
  DoorScan: doorScan,
  InvoiceFlow: invoiceFlow,
  JointState: jointState,
  LargestRemainderSplit: largestRemainderSplit,
  ModalFocus: modalFocus,
  ModalLifecycle: modalLifecycle,
  ModelRules: modelRules,
  NotificationFlagLease: notificationFlagLease,
  PaymentReview: paymentReview,
  RefundReversal: refundReversal,
  SharedGroupCapacity: sharedGroupCapacity,
  SquareLinkEnd: squareLinkEnd,
  SubscriptionCancellation: subscriptionCancellation,
  SubscriptionCheckout: subscriptionCheckout,
  SubscriptionLifecycle: subscriptionLifecycle,
  SubscriptionRecords: subscriptionRecords,
  SubscriptionRenewals: subscriptionRenewals,
  SubscriptionRules: subscriptionRules,
  SumupRecovery: sumupRecovery,
  TwoWorkers: twoWorkers,
  VatLedger: vatLedger,
} satisfies Record<string, ModelGuide>;
/* jscpd:ignore-end */

export const GUIDES: readonly ModelGuide[] = Object.values(GUIDE_BY_MODULE);
