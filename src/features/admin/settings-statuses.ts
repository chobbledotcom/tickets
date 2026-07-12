import { handlersFor } from "#routes/admin/handlers.ts";
/**
 * Admin routes for managing attendee statuses (owner-only).
 *
 * Enforces the status invariants: at most one public-default and one
 * paid-default, a paid-default is never a reservation, reservation amounts are
 * valid, and the last/in-use/default statuses can't be deleted.
 */

/* jscpd:ignore-start */
import { verifyOrRedirect } from "#routes/admin/confirmation.ts";
import { OWNER_FORM, ownerPage, requireOwnerOr } from "#routes/auth.ts";
import { applyFlash } from "#routes/csrf.ts";
import {
  type IdRouteHandler,
  ownerFormById,
  withEntity,
} from "#routes/entity.ts";
import {
  errorRedirect,
  htmlResponse,
  notFoundResponse,
  redirect,
} from "#routes/response.ts";
/* jscpd:ignore-end */
import { createAuthedHandler } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  type AttendeeStatus,
  assignNextAttendeeStatusSortOrder,
  attendeeStatuses,
  getAttendeeStatus,
  swapAttendeeStatusOrder,
} from "#shared/db/attendee-statuses.ts";
import { execute } from "#shared/db/client.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateReservationAmount } from "#shared/reservation-amount.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  adminAttendeeStatusesPage,
  adminAttendeeStatusFormPage,
  statusPages,
} from "#templates/admin/settings-statuses.tsx";

const LIST_PATH = "/admin/settings/statuses";

type StatusFormData = {
  name: string;
  isReservation: boolean;
  reservationAmount: string;
  isPublicDefault: boolean;
  isPaidDefault: boolean;
};

type ParseResult =
  | { ok: true; data: StatusFormData }
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
): StatusFormData | Response => {
  const parsed = parseStatusForm(form);
  return parsed.ok ? parsed.data : errorRedirect(formPath, parsed.error);
};

/** After a write, ensure at most one public-default and one paid-default. */
const clearOtherDefaults = async (
  id: number,
  data: StatusFormData,
): Promise<void> => {
  if (data.isPublicDefault) {
    await execute(
      "UPDATE attendee_statuses SET is_public_default = 0 WHERE id != ?",
      [id],
    );
  }
  if (data.isPaidDefault) {
    await execute(
      "UPDATE attendee_statuses SET is_paid_default = 0 WHERE id != ?",
      [id],
    );
  }
  attendeeStatuses.invalidate();
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
  adminAttendeeStatusFormPage(session, { error: getFlash().error }),
);

/** Owner-guarded GET that loads a status by id (or 404s) and renders a page. */
const ownerStatusPage =
  (
    render: (status: AttendeeStatus, session: AdminSession) => string,
  ): IdRouteHandler =>
  (request, { id }) =>
    requireOwnerOr(request, (session) => {
      applyFlash(request);
      return withEntity<AttendeeStatus>((status) =>
        htmlResponse(render(status, session)),
      )(() => getAttendeeStatus(id));
    });

const editGet = ownerStatusPage((status, session) =>
  adminAttendeeStatusFormPage(session, { error: getFlash().error, status }),
);

const createPost = createAuthedHandler({
  auth: OWNER_FORM,
  handle: async ({ form }) => {
    const parsed = parseStatusFormOr(form, `${LIST_PATH}/new`);
    if (parsed instanceof Response) return parsed;
    const status = await attendeeStatuses.table.insert(parsed);
    await assignNextAttendeeStatusSortOrder(status.id);
    await clearOtherDefaults(status.id, parsed);
    await logActivity(`Attendee status '${parsed.name}' created`);
    return redirect(LIST_PATH, "Status created", true);
  },
});

const editPost = ownerFormById(async (id, _session, form) => {
  const existing = await getAttendeeStatus(id);
  if (!existing) return notFoundResponse();
  const parsed = parseStatusFormOr(form, `${LIST_PATH}/${id}/edit`);
  if (parsed instanceof Response) return parsed;

  if (existing.is_public_default && !parsed.isPublicDefault) {
    return errorRedirect(
      `${LIST_PATH}/${id}/edit`,
      "Choose another public default before clearing this one",
    );
  }
  if (existing.is_paid_default && !parsed.isPaidDefault) {
    return errorRedirect(
      `${LIST_PATH}/${id}/edit`,
      "Choose another paid default before clearing this one",
    );
  }

  await attendeeStatuses.table.update(id, parsed);
  await clearOtherDefaults(id, parsed);
  await logActivity(`Attendee status '${parsed.name}' updated`);
  return redirect(LIST_PATH, "Status updated", true);
});

const deleteGet = ownerStatusPage((status, session) =>
  statusPages.deletePage(status, session, getFlash().error),
);

const deletePost = ownerFormById(async (id, _session, form) => {
  const status = await getAttendeeStatus(id);
  if (!status) return notFoundResponse();
  const confirmPath = `${LIST_PATH}/${id}/delete`;
  const mismatch = verifyOrRedirect(
    form,
    status.name,
    confirmPath,
    "Name",
    "deletion",
  );
  if (mismatch) return mismatch;
  const all = await attendeeStatuses.getAll();
  if (all.length <= 1) {
    return errorRedirect(confirmPath, "You must keep at least one status");
  }
  if (status.is_public_default) {
    return errorRedirect(
      confirmPath,
      "Choose another public default before deleting this status",
    );
  }
  if (status.is_paid_default) {
    return errorRedirect(
      confirmPath,
      "Choose another paid default before deleting this status",
    );
  }
  const inUse = await execute(
    "SELECT 1 FROM attendees WHERE status_id = ? LIMIT 1",
    [id],
  );
  if (inUse.rows.length > 0) {
    return errorRedirect(confirmPath, "This status is in use by attendees");
  }
  await attendeeStatuses.table.deleteById(id);
  await logActivity(`Attendee status '${status.name}' deleted`);
  return redirect(LIST_PATH, "Status deleted", true);
});

/** Factory for move-up / move-down handlers (swap with the ordered neighbour). */
const moveHandler = (direction: -1 | 1) =>
  ownerFormById(async (id) => {
    const all = await attendeeStatuses.getAll();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) return notFoundResponse();
    const neighbor = all[idx + direction];
    if (neighbor) await swapAttendeeStatusOrder(id, neighbor.id);
    return redirect(LIST_PATH, "Status moved", true);
  });

export const adminHandlers = handlersFor("settingsStatuses")({
  getSettingsStatuses: listGet,
  getSettingsStatusesByIdDelete: deleteGet,
  getSettingsStatusesByIdEdit: editGet,
  getSettingsStatusesNew: newGet,
  postSettingsStatuses: createPost,
  postSettingsStatusesByIdDelete: deletePost,
  postSettingsStatusesByIdEdit: editPost,
  postSettingsStatusesByIdMoveDown: moveHandler(1),
  postSettingsStatusesByIdMoveUp: moveHandler(-1),
});
