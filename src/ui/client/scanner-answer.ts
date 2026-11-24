// Browser-only code - the door's answer to one scan, as the scan API sends it.
// The shapes mirror the JSON that `src/features/admin/scan-reply.ts` builds.

/** What a queued check-in named against what its booking can still admit.
 * The door alerts staff when the booking fell short. */
type OverAdmission = {
  admitted: number;
  bought: number;
  named: number;
};

/** The person and booking a decision names. */
type Booking = {
  listingName: string;
  name: string;
  quantity: number;
  total: number;
};

/** The door's decision for one scan. A `checked_in` or `already_checked_in`
 * answer can also carry the over-admission alert. */
export type ScanAnswer =
  | (Booking & {
      overAdmission?: OverAdmission;
      status: "already_checked_in" | "checked_in";
    })
  | (Booking & { status: "verify_id" })
  | { listingName: string; name: string; status: "wrong_listing" }
  | { max: number; name: string; status: "select_quantity" }
  | { name: string; status: "refunded" }
  | { status: "not_found" }
  | { message: string; status: "error" };
