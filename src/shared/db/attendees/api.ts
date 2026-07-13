/**
 * Stubbable wrappers around the atomic attendee operations.
 *
 * Tests replace entries on `attendeesApi` to simulate capacity races and
 * atomic-write failures without touching the database; production code calls
 * the wrapper functions, which delegate to the live entry at call time.
 */

import type { CreateAttendeeResult } from "#shared/db/attendee-types.ts";
import { applyAttendeeAtomicEdit as applyAttendeeAtomicEditImpl } from "#shared/db/attendees/atomic-update.ts";
import {
  checkBatchAvailabilityImpl,
  checkListingAvailability,
} from "#shared/db/attendees/capacity.ts";
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

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const applyAttendeeAtomicEdit = (
  ...args: Parameters<typeof attendeesApi.applyAttendeeAtomicEdit>
): ReturnType<typeof attendeesApi.applyAttendeeAtomicEdit> =>
  attendeesApi.applyAttendeeAtomicEdit(...args);

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const hasAvailableSpots = (
  ...args: Parameters<typeof attendeesApi.hasAvailableSpots>
): Promise<boolean> => attendeesApi.hasAvailableSpots(...args);

/** Wrapper for test mocking - delegates to attendeesApi at runtime. Forwards the
 *  optional ledger-poster so the paid path can post legs in the create
 *  transaction. */
export const createAttendeeAtomic = (
  ...args: Parameters<typeof attendeesApi.createAttendeeAtomic>
): Promise<CreateAttendeeResult> => attendeesApi.createAttendeeAtomic(...args);

/** Wrapper for test mocking - delegates to attendeesApi at runtime. Creates a
 * booking and posts its ledger legs in one all-or-nothing batch. */
export const createBookingAtomic = (
  ...args: Parameters<typeof attendeesApi.createBookingAtomic>
): ReturnType<typeof attendeesApi.createBookingAtomic> =>
  attendeesApi.createBookingAtomic(...args);

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const checkBatchAvailability = (
  ...args: Parameters<typeof attendeesApi.checkBatchAvailability>
): Promise<boolean> => attendeesApi.checkBatchAvailability(...args);
