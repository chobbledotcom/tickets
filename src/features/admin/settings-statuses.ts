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
import { defineRoutes } from "#routes/router.ts";
/* jscpd:ignore-end */
import { createAuthedHandler } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  type AttendeeStatus,
  assignNextAttendeeStatusSortOrder,
  attendeeStatusesTable,
  getAllAttendeeStatuses,
  getAttendeeStatus,
  invalidateAttendeeStatusesCache,
  swapAttendeeStatusOrder,
} from "#shared/db/attendee-statuses.ts";
import { execute } from "#shared/db/client.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { validateReservationAmount } from "#shared/reservation-amount.ts";
import type { AdminSession } from "#shared/types.ts";
import {
  adminAttendeeStatusDeletePage,
  adminAttendeeStatusesPage,
  adminAttendeeStatusFormPage,
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
  invalidateAttendeeStatusesCache();
};

const listGet = ownerPage(async (session) => {
  const statuses = await getAllAttendeeStatuses();
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
    const parsed = parseStatusForm(form);
    if (!parsed.ok) return errorRedirect(`${LIST_PATH}/new`, parsed.error);
    const status = await attendeeStatusesTable.insert(parsed.data);
    await assignNextAttendeeStatusSortOrder(status.id);
    await clearOtherDefaults(status.id, parsed.data);
    await logActivity(`Attendee status '${parsed.data.name}' created`);
    return redirect(LIST_PATH, "Status created", true);
  },
});

const editPost = ownerFormById(async (id, _session, form) => {
  const existing = await getAttendeeStatus(id);
  if (!existing) return notFoundResponse();
  const parsed = parseStatusForm(form);
  if (!parsed.ok) return errorRedirect(`${LIST_PATH}/${id}/edit`, parsed.error);

  if (existing.is_public_default && !parsed.data.isPublicDefault) {
    return errorRedirect(
      `${LIST_PATH}/${id}/edit`,
      "Choose another public default before clearing this one",
    );
  }
  if (existing.is_paid_default && !parsed.data.isPaidDefault) {
    return errorRedirect(
      `${LIST_PATH}/${id}/edit`,
      "Choose another paid default before clearing this one",
    );
  }

  await attendeeStatusesTable.update(id, parsed.data);
  await clearOtherDefaults(id, parsed.data);
  await logActivity(`Attendee status '${parsed.data.name}' updated`);
  return redirect(LIST_PATH, "Status updated", true);
});

const deleteGet = ownerStatusPage((status, session) =>
  adminAttendeeStatusDeletePage(status, session, getFlash().error),
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
  const all = await getAllAttendeeStatuses();
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
  await attendeeStatusesTable.deleteById(id);
  await logActivity(`Attendee status '${status.name}' deleted`);
  return redirect(LIST_PATH, "Status deleted", true);
});

/** Factory for move-up / move-down handlers (swap with the ordered neighbour). */
const moveHandler = (direction: -1 | 1) =>
  ownerFormById(async (id) => {
    const all = await getAllAttendeeStatuses();
    const idx = all.findIndex((s) => s.id === id);
    if (idx === -1) return notFoundResponse();
    const neighbor = all[idx + direction];
    if (neighbor) await swapAttendeeStatusOrder(id, neighbor.id);
    return redirect(LIST_PATH, "Status moved", true);
  });

export const attendeeStatusesRoutes = defineRoutes({
  "GET /admin/settings/statuses": listGet,
  "GET /admin/settings/statuses/:id/delete": deleteGet,
  "GET /admin/settings/statuses/:id/edit": editGet,
  "GET /admin/settings/statuses/new": newGet,
  "POST /admin/settings/statuses": createPost,
  "POST /admin/settings/statuses/:id/delete": deletePost,
  "POST /admin/settings/statuses/:id/edit": editPost,
  "POST /admin/settings/statuses/:id/move-down": moveHandler(1),
  "POST /admin/settings/statuses/:id/move-up": moveHandler(-1),
});
