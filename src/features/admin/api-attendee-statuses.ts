/**
 * Admin JSON API routes for the attendee-statuses resource. The status
 * record owns the field rule and the write boundary, and its page route
 * declares the owner-only audience.
 */

import type {
  AttendeeStatus,
  AttendeeStatusWriteInput,
} from "#db/attendee-statuses.ts";
import type { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { statusRecord } from "#shared/records/statuses.ts";
import { withWriteName } from "#shared/rest/crud-parsers.ts";
import { recordApi } from "#shared/rest/record-api.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** One status write body after the resource table's schema validates it. */
type StatusWriteBody = {
  is_paid_default?: boolean | undefined;
  is_public_default?: boolean | undefined;
  is_reservation?: boolean | undefined;
  name?: string | undefined;
  reservation_amount?: string | undefined;
};

/** The refusal for an amount on a write whose status is not a reservation.
 *  The form stores an amount only beside the reservation flag. A body that
 *  carries one without the flag asks for a row the form cannot hold. */
const AMOUNT_WITHOUT_RESERVATION =
  "reservation_amount only applies to a reservation. Set is_reservation to true, or leave reservation_amount out.";

/** The amount a status stores: "0" for a non-reservation, the caller's value
 *  for a reservation. An amount sent for a non-reservation is refused, never
 *  dropped. The record rule validates a reservation's amount. */
const reservationAmountFrom = (
  body: StatusWriteBody,
  isReservation: boolean,
  stored: string,
): Result<string> => {
  const raw = body.reservation_amount;
  if (!isReservation) {
    return raw === undefined
      ? okResult("0")
      : errorResult(AMOUNT_WITHOUT_RESERVATION);
  }
  return okResult(raw ?? stored);
};

/** Parse one status write body into the record's input. A create answers the
 * stored defaults for a silent field (off flags, "0" amount). An update keeps
 * the stored value. The record's rule runs after this. */
const statusInputFrom = withWriteName<
  StatusWriteBody,
  AttendeeStatus,
  AttendeeStatusWriteInput
>((name, body, existing) => {
  const flags = {
    isPaidDefault: body.is_paid_default ?? existing?.is_paid_default ?? false,
    isPublicDefault:
      body.is_public_default ?? existing?.is_public_default ?? false,
    isReservation: body.is_reservation ?? existing?.is_reservation ?? false,
  };
  const amount = reservationAmountFrom(
    body,
    flags.isReservation,
    existing?.reservation_amount ?? "",
  );
  if (!amount.ok) return amount;
  return okResult({
    ...flags,
    name,
    reservationAmount: amount.value,
  });
});

export const attendeeStatusApiRoutes = recordApi<
  (typeof ADMIN_API_RESOURCES)["attendee-statuses"],
  AttendeeStatus,
  AttendeeStatusWriteInput
>(statusRecord, {
  stripKeys: ["sort_order"],
  toCreateInput: (body) => statusInputFrom(body, null),
  toUpdateInput: (body, existing) => statusInputFrom(body, existing),
});
