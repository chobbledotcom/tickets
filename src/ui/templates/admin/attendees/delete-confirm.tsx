/** Attendee deletion confirmations, including the no-submit blocked page. */

import { t } from "#i18n";
import { attendeeRouteConfirm } from "#templates/admin/attendees.tsx";
import { CheckboxLabel } from "#templates/components/aggregate-sections.tsx";

const deleteConfirm = {
  buttonText: t("admin.attendees.delete_submit"),
  confirmKey: "admin.attendees.delete_confirm",
  titleAction: "Delete Attendee",
  warningPrefix: "Warning",
  warningText:
    "This will permanently remove this attendee from the listing and delete any associated payment records.",
};

/** Admin delete attendee confirmation page. */
export const adminAttendeeDeletePage = attendeeRouteConfirm("delete", {
  ...deleteConfirm,
  body: (
    <>
      <CheckboxLabel
        checked
        label={` ${t("admin.attendees.release_bookings")}`}
        name="release_bookings"
        value="1"
      />
      <p>
        <small>{t("admin.attendees.release_bookings_note")}</small>
      </p>
    </>
  ),
});

/** Explain why deletion is blocked without leaving a destructive form. */
export const adminBlockedAttendeeDeletePage = attendeeRouteConfirm("delete", {
  ...deleteConfirm,
  disabled: true,
});
