import { route } from "#shared/admin-surface/definitions.ts";

export const routes = [
  route(
    "getAttendeeByAttendeeIdNote",
    "attendeeNotes",
    "GET",
    "/admin/attendee/:attendeeId/note",
  ),
  route(
    "getAttendeeByAttendeeIdNoteByNoteIdDelete",
    "attendeeNotes",
    "GET",
    "/admin/attendee/:attendeeId/note/:noteId/delete",
  ),
  route(
    "postAttendeeByAttendeeIdNote",
    "attendeeNotes",
    "POST",
    "/admin/attendee/:attendeeId/note",
  ),
  route(
    "postAttendeeByAttendeeIdNoteByNoteIdDelete",
    "attendeeNotes",
    "POST",
    "/admin/attendee/:attendeeId/note/:noteId/delete",
  ),
] as const;
