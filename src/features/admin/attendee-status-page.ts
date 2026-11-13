/** The owner-only attendee-status Edit / Actions entity page. */

import type { AttendeeStatus } from "#db/attendee-statuses.ts";
import type { EditEntityPage } from "#routes/admin/entity-write-tab.ts";
import { statusRecord } from "#shared/records/statuses.ts";
import { AttendeeStatusEditPanel } from "#templates/admin/settings-statuses.tsx";

import { recordEditPageFor } from "./record-edit-page.ts";

export const attendeeStatusPage: EditEntityPage<AttendeeStatus> =
  recordEditPageFor(
    statusRecord,
    "statusDelete",
    "statuses.delete_button",
    "status",
    (status, _ctx, rejected) =>
      Promise.resolve(
        AttendeeStatusEditPanel({
          status,
          ...(rejected ? { error: rejected.error, values: rejected.form } : {}),
        }),
      ),
  );
