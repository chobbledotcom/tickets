import { defineRoutes } from "#routes/router.ts";

/**
 * Owner notes are encrypted with the owner public key. The read paths derive
 * the request private key, which an admin session always has, because the same
 * key decrypts attendee PII. Every action carries a `return_url`, so the
 * operator lands back where they were.
 */

import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { bindNoteRoutes, recordNoteFeature } from "./record-notes.ts";

/** The attendee's note routes and its page banner wiring. Attendee pages are
 * staff-visible, and the note routes declare the same staff floor the "any"
 * shorthand enforces. */
export const attendeeNoteFeature = recordNoteFeature({
  activeSection: adminPattern("attendees"),
  auth: "any",
  entityKind: "attendee",
  loadRecord: async (attendeeId) =>
    getAttendeeOrNull(attendeeId, await requireRequestPrivateKey()),
  nameOf: (attendee) => attendee.name,
  noteBasePath: (attendeeId) => `/admin/attendee/${attendeeId}/note`,
  recordPagePath: (attendeeId) => `/admin/attendees/${attendeeId}`,
});

export const adminHandlers = defineRoutes({
  ...bindNoteRoutes(
    "/admin/attendee",
    "attendeeId",
    attendeeNoteFeature.routes,
  ),
});
