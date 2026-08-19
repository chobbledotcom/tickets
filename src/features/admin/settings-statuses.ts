/* jscpd:ignore-start */
import { crudRoutes, entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";
/* jscpd:ignore-end */
/**
 * Admin routes for managing attendee statuses (owner-only).
 *
 * Enforces the status invariants: at most one public-default and one
 * paid-default, a paid-default is never a reservation, reservation amounts are
 * valid, and the last/in-use/default statuses can't be deleted.
 */

/* jscpd:ignore-start */
import { createCrudHandlers } from "#routes/admin/crud-handlers.ts";
import { OWNER_FORM } from "#routes/auth.ts";
import { createOrderedCollectionHandlers } from "#shared/app-forms.ts";
import {
  type AttendeeStatus,
  type AttendeeStatusDeleteError,
  type AttendeeStatusSaveError,
  type AttendeeStatusWriteInput,
  attendeeStatuses,
  attendeeStatusOrder,
  attendeeStatusWrites,
  getAttendeeStatus,
} from "#shared/db/attendee-statuses.ts";
import { flatCollectionSwap } from "#shared/db/ordered-collection.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateReservationAmount } from "#shared/reservation-amount.ts";
import type { NamedOperations } from "#shared/rest/resource.ts";
import type { Result } from "#shared/result.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { statusPages } from "#templates/admin/settings-statuses.tsx";
import { attendeeStatusPage } from "./attendee-status-page.ts";

/* jscpd:ignore-end */

const LIST_PATH = adminPattern("statuses");

/** Parse and validate the status form. */
const parseStatusForm = (
  form: FormParams,
): Result<AttendeeStatusWriteInput> => {
  const isReservation = form.has("is_reservation");
  const input = {
    isPaidDefault: form.has("is_paid_default"),
    isPublicDefault: form.has("is_public_default"),
    isReservation,
    name: form.getString("name"),
    reservationAmount: isReservation
      ? form.getString("reservation_amount")
      : "0",
  };
  if (!input.name) return { error: "Please enter a name", ok: false };
  if (input.isReservation && input.isPaidDefault) {
    return { error: "A paid status can't also be a reservation", ok: false };
  }
  const error = isReservation
    ? validateReservationAmount(input.reservationAmount)
    : null;
  return error ? errorResult(error) : okResult(input);
};

const SAVE_ERRORS: Record<AttendeeStatusSaveError, string> = {
  paid_default_required: "Choose another paid default before clearing this one",
  public_default_required:
    "Choose another public default before clearing this one",
};

const DELETE_ERRORS: Record<AttendeeStatusDeleteError, string> = {
  last_status: "You must keep at least one status",
  paid_default: "Choose another paid default before deleting this status",
  public_default: "Choose another public default before deleting this status",
  status_in_use: "This status is in use by attendees",
};

const saveStatus = async (id: number | null, form: FormParams) => {
  const parsed = parseStatusForm(form);
  if (!parsed.ok) return parsed;
  const saved = await attendeeStatusWrites.save(id, parsed.value);
  if (!saved.ok) return errorResult(SAVE_ERRORS[saved.error]);
  return { ok: true as const, row: saved.value };
};

const statusOperations: NamedOperations<AttendeeStatus> = {
  create: (form) => saveStatus(null, form),
  delete: async (id) => {
    const result = await attendeeStatusWrites.delete(id);
    return result.ok
      ? { ok: true }
      : { error: DELETE_ERRORS[result.error], ok: false };
  },
  loadOrNull: getAttendeeStatus,
  update: async (id, form) =>
    (await getAttendeeStatus(id)) === null
      ? { notFound: true, ok: false }
      : saveStatus(id, form),
};

const crud = createCrudHandlers({
  activityName: "Attendee status",
  getAll: attendeeStatuses.getAll,
  getCreatePath: () => LIST_PATH,
  getName: (status) => status.name,
  getRowPath: (status) => attendeeStatusPage.path(status.id),
  identifierLabel: "Name",
  list: "statuses",
  operations: statusOperations,
  renderDelete: statusPages.deletePage,
  renderEditError: attendeeStatusPage.renderEditError,
  renderList: (statuses, session, success) =>
    statusPages.listPage(statuses, session, getFlash().error, success),
  renderNew: statusPages.newPage,
  singular: "Status",
});

const statusOrder = createOrderedCollectionHandlers({
  auth: OWNER_FORM,
  keys: async () =>
    (await attendeeStatuses.getAll()).map((status) => status.id),
  loadContext: ({ id }: { id: number }) => getAttendeeStatus(id),
  movedMessage: "Status moved",
  redirectPath: () => LIST_PATH,
  swap: flatCollectionSwap(attendeeStatusOrder),
  target: ({ context }) => context.id,
});

export const adminHandlers = defineRoutes({
  ...crudRoutes(adminPattern("statuses"), crud),
  ...entityTabRoutes(adminPattern("status"), attendeeStatusPage),
  "POST /admin/settings/statuses/:id/move-down": statusOrder.down,
  "POST /admin/settings/statuses/:id/move-up": statusOrder.up,
});
