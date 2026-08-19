/** The owner-only attendee-status Edit / Actions entity page. */

import {
  type AttendeeStatus,
  getAttendeeStatus,
} from "#db/attendee-statuses.ts";
/* jscpd:ignore-start */
import {
  defineEditEntityPage,
  type EditEntityPage,
} from "#routes/admin/entity-write-tab.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import { AttendeeStatusEditPanel } from "#templates/admin/settings-statuses.tsx";

/* jscpd:ignore-end */

const LIST_PATH = "/admin/settings/statuses";

export const attendeeStatusPage: EditEntityPage<AttendeeStatus> =
  defineEditEntityPage({
    basePath: (id) => `${LIST_PATH}/${id}`,
    deleteLabelKey: "statuses.delete_button",
    edit: (status, _ctx, rejected) =>
      Promise.resolve(
        AttendeeStatusEditPanel({
          status,
          ...(rejected ? { error: rejected.error, values: rejected.form } : {}),
        }),
      ),
    guard: requireOwnerOr,
    load: (id) => getAttendeeStatus(id),
    navActive: LIST_PATH,
  });
