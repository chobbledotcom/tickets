/** The single-attendee target: one person, reached from their own edit page by
 * ticket token. The only target that always means one recipient. */

import { getAttendeePiiBlobForToken } from "#shared/db/attendees/queries.ts";
import {
  type AttendeeTarget,
  fixedControl,
  fromRawField,
  type TargetSpec,
} from "./types.ts";

/** Build an attendee target from a (non-empty) ticket token. */
const attendeeTargetFromRaw = (token: string): AttendeeTarget => ({
  kind: "attendee",
  token,
});

export const attendeeSpec: TargetSpec<AttendeeTarget> = {
  allowEmpty: false,
  composeControl: (target) => fixedControl("attendee", target.token),
  composeCopy: {
    heading: "Email an attendee",
    intro:
      "Send a one-off email to this attendee. Write your message in Markdown, then preview before sending.",
  },
  describe: (_target, recipients) => ({
    targetLabel: recipients[0] ?? "the selected attendee",
  }),
  fromForm: (form) =>
    fromRawField(attendeeTargetFromRaw)(form.getString("attendee")),
  fromQuery: (params) =>
    fromRawField(attendeeTargetFromRaw)(params.get("attendee")),
  loadPiiBlobs: async (target) => {
    const blob = await getAttendeePiiBlobForToken(target.token);
    return blob ? [blob] : [];
  },
  logListingId: () => null,
  singleRecipient: true,
  toQuery: (target) => `?attendee=${encodeURIComponent(target.token)}`,
};
