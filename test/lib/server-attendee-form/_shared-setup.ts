import { attendeeLineFields } from "#test-utils/db-helpers/attendees.ts";

/** Build the form fields for a new attendee booking one listing line. The email
 *  is only added when given, matching the two ways the create form is driven:
 *  with an email and without one. */
export const oneLineAttendeeForm = (fields: {
  name: string;
  eventId: number;
  email?: string;
  quantity?: number;
}): Record<string, string> => ({
  ...(fields.email !== undefined && { email: fields.email }),
  name: fields.name,
  ...attendeeLineFields([
    { eventId: fields.eventId, quantity: fields.quantity ?? 1 },
  ]),
});
