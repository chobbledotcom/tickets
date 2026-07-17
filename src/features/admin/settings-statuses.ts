/* jscpd:ignore-start */
import { handlersFor } from "#routes/admin/handlers.ts";
import { planReorder } from "#shared/reorder.ts";
/* jscpd:ignore-end */
/**
 * Admin routes for managing attendee statuses (owner-only).
 *
 * Enforces the status invariants: at most one public-default and one
 * paid-default, a paid-default is never a reservation, reservation amounts are
 * valid, and the last/in-use/default statuses can't be deleted.
 */

/* jscpd:ignore-start */
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import {
  formGuard,
  OWNER_FORM,
  ownerPage,
  requireOwnerOr,
} from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { ownerFormHandler } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  type AttendeeStatus,
  type AttendeeStatusDeleteError,
  type AttendeeStatusSaveError,
  type AttendeeStatusWriteInput,
  attendeeStatuses,
  attendeeStatusWrites,
  getAttendeeStatus,
  swapAttendeeStatusOrder,
} from "#shared/db/attendee-statuses.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateReservationAmount } from "#shared/reservation-amount.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  AttendeeStatusEditPanel,
  adminAttendeeStatusesPage,
  adminAttendeeStatusNewPage,
  statusPages,
} from "#templates/admin/settings-statuses.tsx";
import { attendeeStatusPage } from "./attendee-status-page.ts";

/* jscpd:ignore-end */

const LIST_PATH = "/admin/settings/statuses";

type ParseResult =
  | { ok: true; data: AttendeeStatusWriteInput }
  | { ok: false; error: string };

/** Parse and validate the status form. */
const parseStatusForm = (form: FormParams): ParseResult => {
  const name = form.getString("name");
  if (!name) return { error: "Please enter a name", ok: false };

  const isReservation = form.has("is_reservation");
  const isPaidDefault = form.has("is_paid_default");
  const isPublicDefault = form.has("is_public_default");

  if (isReservation && isPaidDefault) {
    return { error: "A paid status can't also be a reservation", ok: false };
  }

  let reservationAmount = "0";
  if (isReservation) {
    const raw = form.getString("reservation_amount");
    const error = validateReservationAmount(raw);
    if (error) return { error, ok: false };
    reservationAmount = raw;
  }

  return {
    data: {
      isPaidDefault,
      isPublicDefault,
      isReservation,
      name,
      reservationAmount,
    },
    ok: true,
  };
};

// Parses the status form for a page whose form lives at `formPath`. Returns the
// valid data, or the redirect back to that form carrying the error message.
const parseStatusFormOr = (
  form: FormParams,
  formPath: string,
): AttendeeStatusWriteInput | Response => {
  const parsed = parseStatusForm(form);
  return parsed.ok ? parsed.data : errorRedirect(formPath, parsed.error);
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

const listGet = ownerPage(async (session) => {
  const statuses = await attendeeStatuses.getAll();
  const flash = getFlash();
  return adminAttendeeStatusesPage(
    statuses,
    session,
    flash.error,
    flash.success,
  );
});

const newGet = ownerPage((session) =>
  adminAttendeeStatusNewPage(session, getFlash().error),
);

const statusHandler = createIdEntityHandler<AttendeeStatus>(getAttendeeStatus);
const statusHandlers = {
  get: statusHandler(requireOwnerOr),
  post: statusHandler(formGuard(OWNER_FORM)),
};

/** Owner-guarded GET that loads a status by id (or 404s) and renders a page. */
const ownerStatusPage = (
  render: (status: AttendeeStatus, session: AdminSession) => string,
): IdRouteHandler =>
  statusHandlers.get((status, session, request) => {
    applyFlash(request);
    return htmlResponse(render(status, session));
  });

const createPost = ownerFormHandler(async ({ form }) => {
  const parsed = parseStatusFormOr(form, `${LIST_PATH}/new`);
  if (parsed instanceof Response) return parsed;
  await attendeeStatusWrites.save(null, parsed);
  await logActivity(`Attendee status '${parsed.name}' created`);
  return redirect(LIST_PATH, "Status created", true);
});

const editPost = statusHandlers.post(
  async (_existing, session, form, _request, { id }) => {
    const renderError = (error: string): Promise<Response> =>
      attendeeStatusPage.renderPage(session, id, "edit", {
        panel: (status) =>
          Promise.resolve(
            AttendeeStatusEditPanel({ error, status, values: form }),
          ),
        status: 400,
      });
    const parsed = parseStatusForm(form);
    if (!parsed.ok) return renderError(parsed.error);

    const saved = await attendeeStatusWrites.save(id, parsed.data);
    if (!saved.ok) {
      return renderError(SAVE_ERRORS[saved.error]);
    }
    await logActivity(`Attendee status '${parsed.data.name}' updated`);
    return redirect(attendeeStatusPage.path(id), "Status updated", true);
  },
);

const deleteGet = ownerStatusPage((status, session) =>
  statusPages.deletePage(status, session, getFlash().error),
);

const deletePost = statusHandlers.post(
  async (status, _session, form, _request, { id }) => {
    const confirmPath = `${LIST_PATH}/${id}/delete`;
    const mismatch = verifyOrRedirect(
      form,
      status.name,
      confirmPath,
      "Name",
      "deletion",
    );
    if (mismatch) return mismatch;
    const deleted = await attendeeStatusWrites.delete(id);
    if (!deleted.ok) {
      return errorRedirect(confirmPath, DELETE_ERRORS[deleted.error]);
    }
    await logActivity(`Attendee status '${status.name}' deleted`);
    return redirect(LIST_PATH, "Status deleted", true);
  },
);

/** Factory for move-up / move-down handlers (swap with the ordered neighbour). */
const moveHandler = (dir: "up" | "down") =>
  statusHandlers.post(async (_status, _session, _form, _request, { id }) => {
    const ids = (await attendeeStatuses.getAll()).map((s) => s.id);
    const pair = planReorder(ids, id, dir);
    if (pair) await swapAttendeeStatusOrder(pair[0], pair[1]);
    return redirect(LIST_PATH, "Status moved", true);
  });

export const adminHandlers = handlersFor("settingsStatuses")({
  getSettingsStatuses: listGet,
  getSettingsStatusesById: (request, { id }) =>
    attendeeStatusPage.renderTab(request, id, ""),
  getSettingsStatusesByIdByTab: (request, { id, tab }) =>
    attendeeStatusPage.renderTab(request, id, tab),
  getSettingsStatusesByIdDelete: deleteGet,
  getSettingsStatusesNew: newGet,
  postSettingsStatuses: createPost,
  postSettingsStatusesByIdDelete: deletePost,
  postSettingsStatusesByIdEdit: editPost,
  postSettingsStatusesByIdMoveDown: moveHandler("down"),
  postSettingsStatusesByIdMoveUp: moveHandler("up"),
});
