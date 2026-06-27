/** Discriminator values for rows stored in the attendees table. */

export const ATTENDEE_KIND = "attendee";
export const SERVICING_KIND = "servicing";

export type AttendeeKind = typeof ATTENDEE_KIND | typeof SERVICING_KIND;

export const isServicing = (
  kind: string | null | undefined,
): kind is typeof SERVICING_KIND => kind === SERVICING_KIND;
