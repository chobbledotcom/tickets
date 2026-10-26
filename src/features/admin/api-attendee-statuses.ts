/**
 * Admin JSON API routes for the attendee-statuses resource. The dashboard's
 * status settings are owner-only, so the JSON API matches (OWNER_API). The
 * writes go through the shared attendeeStatusWrites boundary. The boundary
 * keeps the single-default invariants: one public default, one paid default,
 * and a paid default is never a reservation.
 */

/* jscpd:ignore-start */
import { attendeeStatusApiTable } from "#db/attendee-status-api-table.ts";
import {
  type AttendeeStatus,
  type AttendeeStatusWriteInput,
  attendeeStatusDeleteMessage,
  attendeeStatuses,
  heldAttendeeCount,
  statusDeleteProspects,
} from "#db/attendee-statuses.ts";
import { catalogNameLengthError } from "#db/name-registry.ts";
import { t } from "#i18n";
import { OWNER_API } from "#routes/auth.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { validateReservationAmount } from "#shared/reservation-amount.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import {
  optionalBoolean,
  requireEntityName,
} from "#shared/rest/crud-parsers.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/* jscpd:ignore-end */

const ENTRY = ADMIN_API_RESOURCES["attendee-statuses"];

/** The three owner flags a status write carries: their wire names and the
 *  input keys they map to. */
const FLAG_FIELDS = [
  ["is_public_default", "isPublicDefault"],
  ["is_paid_default", "isPaidDefault"],
  ["is_reservation", "isReservation"],
] as const;

/** The amount a status stores: "0" for a non-reservation, the caller's
 *  validated value for a reservation. */
const reservationAmountFrom = (
  body: Record<string, unknown>,
  isReservation: boolean,
  stored: string,
): Result<string> => {
  if (!isReservation) return okResult("0");
  const raw = body.reservation_amount;
  if (raw !== undefined && typeof raw !== "string") {
    return errorResult("reservation_amount must be a string");
  }
  const amount = typeof raw === "string" ? raw : stored;
  const amountError = validateReservationAmount(amount);
  return amountError === null ? okResult(amount) : errorResult(amountError);
};

/** Parse one status write body into the shared write input. A create answers
 *  the stored defaults for a silent field (off flags, "0" amount). An update
 *  keeps the stored value. */
const statusInputFrom = (
  body: Record<string, unknown>,
  existing: AttendeeStatus | null,
): Result<AttendeeStatusWriteInput> => {
  const name = requireEntityName(body, existing);
  if (!name.ok) return name;
  const nameLengthError = catalogNameLengthError(name.value);
  if (nameLengthError) return errorResult(nameLengthError);

  // Each flag reads as a real boolean. An absent key keeps the stored value
  // (off on create). The first refusal answers the whole parse.
  const flags: {
    isPaidDefault: boolean;
    isPublicDefault: boolean;
    isReservation: boolean;
  } = { isPaidDefault: false, isPublicDefault: false, isReservation: false };
  for (const [field, inputKey] of FLAG_FIELDS) {
    const flag = optionalBoolean(body, field, existing?.[field] ?? false);
    if (!flag.ok) return flag;
    flags[inputKey] = flag.value;
  }

  // The form's rule: a paid status is never a reservation.
  if (flags.isReservation && flags.isPaidDefault) {
    return errorResult(t("statuses.error_paid_default_reservation"));
  }
  const amount = reservationAmountFrom(
    body,
    flags.isReservation,
    existing?.reservation_amount ?? "",
  );
  if (!amount.ok) return amount;

  return okResult({
    ...flags,
    name: name.value,
    reservationAmount: amount.value,
  });
};

/** The one delete the API refuses beyond the shared confirm-by-name check: a
 *  status the write boundary or a booking still depends on. */
const statusDeleteRefusal = async (id: number): Promise<string | null> => {
  const prospects = await statusDeleteProspects(id);
  if (prospects.blocker) {
    return attendeeStatusDeleteMessage(prospects.blocker);
  }
  return (await heldAttendeeCount(id)) > 0
    ? attendeeStatusDeleteMessage("status_in_use")
    : null;
};

export const attendeeStatusApiRoutes = defineCrudApi<
  (typeof ADMIN_API_RESOURCES)["attendee-statuses"],
  AttendeeStatus,
  AttendeeStatusWriteInput
>(ENTRY, {
  getAll: attendeeStatuses.getAll,
  nameField: "name",
  policy: OWNER_API,
  // Reordering is a dashboard concern. The API has no verb for it, so the
  // answer hides the sort order.
  stripKeys: ["sort_order"],
  table: attendeeStatusApiTable,
  toCreateInput: (body) => statusInputFrom(body, null),
  toUpdateInput: (body, existing) => statusInputFrom(body, existing),
  validateDelete: statusDeleteRefusal,
});
