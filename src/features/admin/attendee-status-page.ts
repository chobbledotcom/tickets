/** The owner-only attendee-status Edit / Actions entity page. */

/* jscpd:ignore-start */
import {
  defineEditEntityPage,
  type EditEntityPage,
} from "#routes/admin/entity-write-tab.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import {
  type AttendeeStatus,
  getAttendeeStatus,
} from "#shared/db/attendee-statuses.ts";
import { AttendeeStatusEditPanel } from "#templates/admin/settings-statuses.tsx";

/* jscpd:ignore-end */

export const attendeeStatusPage: EditEntityPage<AttendeeStatus> =
  defineEditEntityPage({
    deleteLabelKey: "statuses.delete_button",
    destination: "status",
    edit: (status, _ctx, rejected) =>
      Promise.resolve(
        AttendeeStatusEditPanel({
          status,
          ...(rejected ? { error: rejected.error, values: rejected.form } : {}),
        }),
      ),
    load: (id) => getAttendeeStatus(id),
    navActive: adminPattern("statuses"),
  });
