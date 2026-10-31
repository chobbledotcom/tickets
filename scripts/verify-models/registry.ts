/* jscpd:ignore-start -- imports */
import { attendeeCapacityModelData } from "#scripts/verify-models/attendee-capacity.ts";
import { bookingReplayModelData } from "#scripts/verify-models/booking.ts";
import { checkoutCompositionModelData } from "#scripts/verify-models/checkout-composition.ts";
import { doorScanModelData } from "#scripts/verify-models/door-scan.ts";
import { largestRemainderSplitModelData } from "#scripts/verify-models/largest-remainder-split.ts";
import { modelData, paymentModel } from "#scripts/verify-models/model.ts";
import { notificationFlagLeaseModelData } from "#scripts/verify-models/notification-flag-lease.ts";
import { refundReversalModelData } from "#scripts/verify-models/refund-reversal.ts";
import { reviewModelData } from "#scripts/verify-models/review.ts";
import { sharedGroupCapacityModelData } from "#scripts/verify-models/shared-group-capacity.ts";
import { squareModelData } from "#scripts/verify-models/square.ts";
import { sumupModelData } from "#scripts/verify-models/sumup.ts";
import { twoWorkersModelData } from "#scripts/verify-models/two-workers.ts";
import { vatModelData } from "#scripts/verify-models/vat.ts";
/* jscpd:ignore-end */

/** Every checked model: the checker module in `verification/` and the
 *  generator that feeds it production facts. A model file without an entry
 *  here never runs; the registry test holds this list to the directory. */
export const MODELS = [
  { data: vatModelData, module: "VatLedger" },
  { data: squareModelData, module: "SquareLinkEnd" },
  { data: sumupModelData, module: "SumupRecovery" },
  { data: reviewModelData, module: "PaymentReview" },
  { data: largestRemainderSplitModelData, module: "LargestRemainderSplit" },
  { data: checkoutCompositionModelData, module: "CheckoutComposition" },
  { data: async () => modelData(await paymentModel()), module: "JointState" },
  { data: bookingReplayModelData, module: "BookingReplay" },
  { data: twoWorkersModelData, module: "TwoWorkers" },
  { data: notificationFlagLeaseModelData, module: "NotificationFlagLease" },
  { data: doorScanModelData, module: "DoorScan" },
  { data: sharedGroupCapacityModelData, module: "SharedGroupCapacity" },
  { data: attendeeCapacityModelData, module: "AttendeeCapacity" },
  { data: refundReversalModelData, module: "RefundReversal" },
];
