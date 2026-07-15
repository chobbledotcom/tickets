/**
 * Stubbable atomic attendee operations.
 *
 * Tests replace entries on `attendeesApi` to simulate capacity races and
 * atomic-write failures without touching the database. Callers read each
 * method from this object at call time so those replacements take effect.
 */

import { applyAttendeeAtomicEdit as applyAttendeeAtomicEditImpl } from "#shared/db/attendees/atomic-update.ts";
import {
  checkBatchAvailabilityImpl,
  checkListingAvailability,
} from "#shared/db/attendees/capacity/checks.ts";
import {
  createAttendeeAtomicImpl,
  createBookingAtomic as createBookingAtomicImpl,
} from "#shared/db/attendees/create.ts";

/** Stubbable API for testing atomic operations */
export const attendeesApi = {
  applyAttendeeAtomicEdit: applyAttendeeAtomicEditImpl,
  checkBatchAvailability: checkBatchAvailabilityImpl,
  createAttendeeAtomic: createAttendeeAtomicImpl,
  createBookingAtomic: createBookingAtomicImpl,
  hasAvailableSpots: checkListingAvailability,
};
