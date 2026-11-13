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
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import { statusRecord } from "#shared/records/statuses.ts";
import { bodyMappers } from "#shared/rest/field-reads.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi } from "#shared/rest/record-api.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The refusal for an amount on a write whose status is not a reservation.
 *  The form stores an amount only beside the reservation flag. A body that
 *  carries one without the flag asks for a row the form cannot hold. */
const AMOUNT_WITHOUT_RESERVATION =
  "reservation_amount only applies to a reservation. Set is_reservation to true, or leave reservation_amount out.";

/** The amount a status stores: "0" for a non-reservation, the value the
 *  fields read for a reservation. An amount sent for a non-reservation is
 *  refused, never dropped. The record rule validates a reservation's amount. */
const withAmountRule = (
  body: { reservation_amount?: string | undefined },
  read: Result<AttendeeStatusWriteInput>,
): Result<AttendeeStatusWriteInput> => {
  if (!read.ok || read.value.isReservation) return read;
  return body.reservation_amount === undefined
    ? okResult({ ...read.value, reservationAmount: "0" })
    : errorResult(AMOUNT_WITHOUT_RESERVATION);
};

/** A create answers the stored defaults for a silent field (off flags). An
 *  update keeps the stored value. The record's rule runs after this. */
const statusBodies = bodyMappers(STATUS_FIELDS);

export const attendeeStatusApiRoutes = recordApi<
  (typeof ADMIN_API_RESOURCES)["attendee-statuses"],
  RecordShapeOf<AttendeeStatus, AttendeeStatusWriteInput>
>(statusRecord, {
  stripKeys: ["sort_order"],
  toCreateInput: (body) =>
    withAmountRule(body, statusBodies.toCreateInput(body)),
  toUpdateInput: (body, existing) =>
    withAmountRule(body, statusBodies.toUpdateInput(body, existing)),
});
