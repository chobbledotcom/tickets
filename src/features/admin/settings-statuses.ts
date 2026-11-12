import {
  crudRoutes,
  defineAdminRoutes,
  entityTabRoutes,
} from "#routes/admin/route-tables.ts";
import { adminDestinationAt, adminPattern } from "#shared/admin-surface.ts";

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
import { flatCollectionSwap } from "#db/ordered-collection.ts";
import { t } from "#i18n";
import { formPolicyFor, pageGuardFor } from "#routes/auth.ts";
import { htmlResponse, notFoundResponse } from "#routes/response.ts";
import { createOrderedCollectionHandlers } from "#shared/app-forms.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormSchema } from "#shared/forms/definition.ts";
import { statusRecord } from "#shared/records/statuses.ts";
import { recordPages } from "#shared/rest/record-pages.ts";
import {
  retireStatusDeletePage,
  type StatusRetire,
  statusPages,
} from "#templates/admin/settings-statuses.tsx";
import { attendeeStatusPage } from "./attendee-status-page.ts";

const LIST_PATH = adminPattern("statuses");

/** The status form boundary: read the submitted fields into the record's
 * input shape. The record's rule runs after this. */
const statusForm: FormSchema<AttendeeStatusWriteInput> = {
  fields: [],
  validate: (form) => {
    const name = form.getString("name");
    if (!name) return { error: "Please enter a name", valid: false };
    const isReservation = form.has("is_reservation");
    return {
      valid: true,
      values: {
        isPaidDefault: form.has("is_paid_default"),
        isPublicDefault: form.has("is_public_default"),
        isReservation,
        name,
        reservationAmount: isReservation
          ? form.getString("reservation_amount")
          : "0",
      },
    };
  },
};

const pages = recordPages(statusRecord, {
  deleteInput: (form) => form.getOptionalInt("reassign_status_id") ?? undefined,
  form: statusForm,
  identifierLabel: t("statuses.name_label"),
  renderDelete: statusPages.deletePage,
  renderEditError: attendeeStatusPage.renderEditError,
  renderList: (statuses, session, success) =>
    statusPages.listPage(statuses, session, getFlash().error, success),
  renderNew: statusPages.newPage,
  singular: "Status",
  toInput: (values) => values,
  updateSavePath: (id) => `/admin/settings/statuses/${id}`,
});

const statusOrder = createOrderedCollectionHandlers({
  auth: formPolicyFor(
    adminDestinationAt("/admin/settings/statuses/:id/move-up"),
  ),
  keys: async () => (await statusRecord.getAll()).map((status) => status.id),
  loadContext: ({ id }: { id: number }) => getAttendeeStatus(id),
  movedMessage: "Status moved",
  redirectPath: () => LIST_PATH,
  swap: flatCollectionSwap(attendeeStatusOrder),
  target: ({ context }) => context.id,
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
  ...crudRoutes(adminPattern("statuses"), pages),
  ...entityTabRoutes(adminPattern("status"), attendeeStatusPage),
  "GET /admin/settings/statuses/:id/delete": (request, { id }) =>
    statusDeleteGet(request, id),
  "POST /admin/settings/statuses/:id/move-down": statusOrder.down,
  "POST /admin/settings/statuses/:id/move-up": statusOrder.up,
});
