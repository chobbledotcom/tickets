/** The owner-only attendee-status Edit / Actions entity page. */

/* jscpd:ignore-start */
import type { EntityPage } from "#routes/admin/entity-pages.ts";
import { defineEditEntityPage } from "#routes/admin/entity-write-tab.ts";
import { requireOwnerOr } from "#routes/auth.ts";
import {
  type AttendeeStatus,
  getAttendeeStatus,
} from "#shared/db/attendee-statuses.ts";
import { AttendeeStatusEditPanel } from "#templates/admin/settings-statuses.tsx";

/* jscpd:ignore-end */

const LIST_PATH = "/admin/settings/statuses";

export const attendeeStatusPage: EntityPage<AttendeeStatus> =
  defineEditEntityPage({
    basePath: (id) => `${LIST_PATH}/${id}`,
    deleteLabelKey: "statuses.delete_button",
    edit: (status) => Promise.resolve(AttendeeStatusEditPanel({ status })),
    guard: requireOwnerOr,
    load: (id) => getAttendeeStatus(id),
    navActive: LIST_PATH,
  });
