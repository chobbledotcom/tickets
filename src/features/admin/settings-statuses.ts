import { defineAdminRoutes, recordRoutes } from "#routes/admin/route-tables.ts";
import { adminDestinationAt } from "#shared/admin-surface.ts";

/**
 * Admin routes for managing attendee statuses (owner-only).
 *
 * The one status record holds the field rule and the write boundary. The
 * delete page is custom because a status attendees hold offers the operator a
 * reassignment choice.
 */

import {
  type AttendeeStatus,
  type AttendeeStatusWriteInput,
  attendeeStatusDeleteMessage,
  attendeeStatusOrder,
  getAttendeeStatus,
  heldAttendeeCount,
  statusDeleteProspects,
} from "#db/attendee-statuses.ts";
import { pageGuardFor } from "#routes/auth.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { getFlash } from "#shared/flash-context.ts";
import { orderedListRoutes } from "#shared/ordered-list-routes.ts";
import { ORDERED_LISTS } from "#shared/ordered-lists.ts";
import { STATUS_FIELDS } from "#shared/records/status-fields.ts";
import { statusRecord } from "#shared/records/statuses.ts";
import { formFieldsInput } from "#shared/rest/field-reads.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import {
  getStatusForm,
  retireStatusDeletePage,
  type StatusRetire,
  statusPages,
} from "#templates/admin/settings-statuses.tsx";
import { attendeeStatusPage } from "./attendee-status-page.ts";

/** The status fields the form shows. The reservation amount applies only to
 *  a reservation, so the input leaves it out for any other status. The
 *  stored column keeps its value: its zero on a new row, the stored amount
 *  on an update. */
const statusInput = (
  values: Record<(typeof STATUS_FIELDS)[number]["key"], string>,
): AttendeeStatusWriteInput =>
  formFieldsInput(
    STATUS_FIELDS,
    values,
    new Set(
      STATUS_FIELDS.filter(
        (field) =>
          field.key !== "reservationAmount" || values.isReservation === "1",
      ).map((field) => field.key),
    ),
  );

const pages = recordPages(statusRecord, {
  deleteInput: (form) => form.getOptionalInt("reassignStatusId") ?? undefined,
  form: getStatusForm(),
  renderDelete: statusPages.deletePage,
  renderEditError: attendeeStatusPage.renderEditError,
  renderList: (statuses, session, success) =>
    statusPages.listPage(statuses, session, getFlash().error, success),
  renderNew: statusPages.newPage,
  singular: "Status",
  toInput: statusInput,
  updateSavePath: (id) => `/admin/settings/statuses/${id}`,
});

const statusOrder = orderedListRoutes(ORDERED_LISTS.status, {
  order: attendeeStatusOrder,
  rows: () => statusRecord.getAll(),
});

/** The delete page, with the reassign choice a status attendees hold needs:
 * the count, the warning, and a required picker of the other statuses. The
 * save refuses without it. The session guard (not the form policy) wraps it,
 * because it is a GET page. */
const statusDeleteGet = (request: Request, id: number): Promise<Response> =>
  pageGuardFor(adminDestinationAt("/admin/settings/statuses/:id/delete"))(
    request,
    async (session) => {
      const status = await getAttendeeStatus(id);
      if (status === null) return notFoundResponse();
      const prospects = await statusDeleteProspects(id);
      const retire = prospects.blocker
        ? { blocked: attendeeStatusDeleteMessage(prospects.blocker) }
        : await reassignChoice(id, prospects.others);
      return htmlResponse(
        retireStatusDeletePage(status, retire, session, getFlash().error),
      );
    },
  );

/** The reassign choice a deletable status attendees hold needs, or null when
 *  nothing holds and the delete can proceed as it stands. */
const reassignChoice = async (
  id: number,
  others: readonly AttendeeStatus[],
): Promise<StatusRetire | null> => {
  const count = await heldAttendeeCount(id);
  return count === 0 ? null : { count, others };
};

export const adminHandlers = defineAdminRoutes({
  ...recordRoutes("settingsStatuses", pages, attendeeStatusPage),
  "GET /admin/settings/statuses/:id/delete": (request, { id }) =>
    statusDeleteGet(request, id),
  ...statusOrder,
});
