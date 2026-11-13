/**
 * The attendee-status record: its table, its one write rule, and its admin
 * surface. The status boundary owns the transaction that keeps the
 * single-default invariants. The rule owns the field checks both doors share.
 */

import {
  type AttendeeStatus,
  type AttendeeStatusSaveError,
  type AttendeeStatusWriteInput,
  attendeeStatusDeleteMessage,
  attendeeStatuses,
  attendeeStatusSaveMessage,
  attendeeStatusWrites,
  getAttendeeStatus,
} from "#db/attendee-statuses.ts";
import { catalogNameLengthError } from "#db/name-registry.ts";
import { t } from "#i18n";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { validateReservationAmount } from "#shared/reservation-amount.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import {
  logNameActivity,
  type RecordShapeOf,
  type WriteVerdict,
} from "#shared/rest/record.ts";
import { commitCommand, updateIfPresent } from "#shared/rest/record-command.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The one status rule: a name the catalog accepts, a paid default that is
 * never a reservation, and a valid reservation amount. */
export const statusRule = (
  input: AttendeeStatusWriteInput,
): Result<AttendeeStatusWriteInput> => {
  const nameLengthError = catalogNameLengthError(input.name);
  if (nameLengthError) return errorResult(nameLengthError);
  if (input.isReservation && input.isPaidDefault) {
    return errorResult(t("statuses.error_paid_default_reservation"));
  }
  const amountError = input.isReservation
    ? validateReservationAmount(input.reservationAmount)
    : null;
  return amountError === null ? okResult(input) : errorResult(amountError);
};

const logStatus = logNameActivity("Attendee status");

/** Save one status with its activity line. The rule runs first. */
const saveStatus = (
  id: number | null,
  input: AttendeeStatusWriteInput,
  verb: "created" | "updated",
): Promise<WriteVerdict<AttendeeStatus>> =>
  commitCommand<
    AttendeeStatus,
    AttendeeStatusWriteInput,
    AttendeeStatusSaveError
  >({
    input,
    log: (status) => logStatus(status.name, verb),
    message: attendeeStatusSaveMessage,
    rule: statusRule,
    stored: null,
    write: (value) => attendeeStatusWrites.save(id, value),
  });

/** The status one delete works on, or the verdict a missing one answers. */
const statusOrNotFound = (status: AttendeeStatus | null) =>
  status === null ? { kind: "not-found" as const } : status;

const statusWrites = {
  create: (input: AttendeeStatusWriteInput) =>
    saveStatus(null, input, "created"),
  remove: async (
    id: number,
    input?: unknown,
  ): Promise<
    | { kind: "deleted" }
    | { kind: "refused"; message: string }
    | { kind: "not-found" }
  > => {
    const status = statusOrNotFound(await getAttendeeStatus(id));
    if ("kind" in status) return status;
    const reassignTo = typeof input === "number" ? input : undefined;
    const deleted = await attendeeStatusWrites.delete(id, reassignTo);
    if (!deleted.ok) {
      return {
        kind: "refused",
        message: attendeeStatusDeleteMessage(deleted.error),
      };
    }
    await logStatus(status.name, "deleted");
    return { kind: "deleted" };
  },
  update: (id: number, input: AttendeeStatusWriteInput) =>
    updateIfPresent(
      getAttendeeStatus,
      () => saveStatus(id, input, "updated"),
      id,
      input,
    ),
} as const;

export const statusRecord = defineNamedRowRecord<
  RecordShapeOf<AttendeeStatus, AttendeeStatusWriteInput>
>({
  activityName: "Attendee status",
  api: ADMIN_API_RESOURCES["attendee-statuses"],
  deleteDestination: "statusDelete",
  getAll: attendeeStatuses.getAll,
  list: "statuses",
  load: getAttendeeStatus,
  loadAfterWrite: (id) => attendeeStatuses.table.findByIdPrimary!(id),
  rule: statusRule,
  table: attendeeStatuses.table,
  write: statusWrites,
});
