import type { AttendeeStatusWriteInput } from "#db/attendee-statuses.ts";

/** A plain status input: not paid, not public, not a reservation. */
export const statusInput = (
  name: string,
  extra: Partial<AttendeeStatusWriteInput> = {},
): AttendeeStatusWriteInput => ({
  isPaidDefault: false,
  isPublicDefault: false,
  isReservation: false,
  name,
  reservationAmount: "0",
  ...extra,
});
