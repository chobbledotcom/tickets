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

import {
  type AttendeeStatus,
  type AttendeeStatusDeleteError,
  type AttendeeStatusSaveError,
  type AttendeeStatusWriteInput,
  attendeeStatuses,
  attendeeStatusOrder,
  attendeeStatusWrites,
  getAttendeeStatus,
} from "#db/attendee-statuses.ts";
import { execute } from "#db/client.ts";
import { flatCollectionSwap } from "#db/ordered-collection.ts";
import { t } from "#i18n";
import { createCrudHandlers } from "#routes/admin/crud-handlers.ts";
import { OWNER_FORM, requireOwnerOr } from "#routes/auth.ts";
/* jscpd:ignore-start */
/* jscpd:ignore-start */
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createOrderedCollectionHandlers } from "#shared/app-forms.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateReservationAmount } from "#shared/reservation-amount.ts";
import type { NamedOperations } from "#shared/rest/resource.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import {
  retireStatusDeletePage,
  statusPages,
} from "#templates/admin/settings-statuses.tsx";
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
    return {
      error: t("statuses.error_paid_default_reservation"),
      ok: false,
    };
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
  status_in_use: t("statuses.delete_in_use_no_target"),
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
  delete: async (id, form) => {
    const result = await attendeeStatusWrites.delete(
      id,
      form?.getOptionalInt("reassign_status_id") ?? undefined,
    );
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

/** How many attendees sit on this status. One count for the delete page's
 *  reassign affordance; the delete command re-counts inside its transaction. */
const heldAttendeeCount = async (id: number): Promise<number> => {
  const result = await execute(
    "SELECT COUNT(*) AS held FROM attendees WHERE status_id = ?",
    [id],
  );
  return Number(result.rows[0]!.held);
};

/** The delete page, with the reassign choice a status attendees hold needs:
 *  the count, the warning, and a required picker of the other statuses. The
 *  session guard (not the form policy) wraps it, because it is a GET page. */
const statusDeleteGet = (request: Request, id: number): Promise<Response> =>
  requireOwnerOr(request, async (session) => {
    const status = await getAttendeeStatus(id);
    if (status === null) return notFoundResponse();
    const [held, others] = await Promise.all([
      heldAttendeeCount(id),
      attendeeStatuses.getAll(),
    ]);
    return htmlResponse(
      retireStatusDeletePage(
        status,
        held,
        others.filter((other) => other.id !== id),
        session,
        getFlash().error,
      ),
    );
  });

export const adminHandlers = defineRoutes({
  ...crudRoutes(adminPattern("statuses"), crud),
  ...entityTabRoutes(adminPattern("status"), attendeeStatusPage),
  "GET /admin/settings/statuses/:id/delete": (request, { id }) =>
    statusDeleteGet(request, id),
  "POST /admin/settings/statuses/:id/move-down": statusOrder.down,
  "POST /admin/settings/statuses/:id/move-up": statusOrder.up,
});
