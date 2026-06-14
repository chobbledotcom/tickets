/**
 * Attendees DB barrel.
 *
 * Implementation is split across files under `./attendees/`:
 * - `attendees/pii.ts` — PII blob build/parse + encrypt/decrypt
 * - `attendees/queries.ts` — SELECT helpers + read queries
 * - `attendees/stats.ts` — aggregated active-event statistics
 * - `attendees/capacity.ts` — availability/capacity checks
 * - `attendees/create.ts` — atomic attendee creation
 * - `attendees/delete.ts` — deletion + event unlink
 * - `attendees/update.ts` — PII, booking, status updates
 */

import type {
  AttendeeInput,
  BatchAvailabilityItem,
  CreateAttendeeResult,
} from "#shared/db/attendee-types.ts";
import {
  checkBatchAvailabilityImpl,
  checkEventAvailability,
} from "#shared/db/attendees/capacity.ts";
import { createAttendeeAtomicImpl } from "#shared/db/attendees/create.ts";

export type {
  ActiveEventStats,
  AttendeeInput,
  AttendeeWithBookings,
  BatchAvailabilityItem,
  CreateAttendeeResult,
  EventAttendeeRow,
  EventBooking,
  UpdateAttendeePIIInput,
  UpdateEventLinkInput,
  UpdateEventLinkResult,
} from "#shared/db/attendee-types.ts";
export {
  getGroupRemainingByEventId,
  getGroupRemainingByGroupId,
  getGroupRemainingForEvent,
} from "#shared/db/attendees/capacity.ts";
export { buildAttendeeInsert } from "#shared/db/attendees/create.ts";
export {
  deleteAttendee,
  unlinkAttendeeFromEvent,
} from "#shared/db/attendees/delete.ts";
export {
  buildPiiBlob,
  contactFields,
  decryptAttendeeFields,
  decryptAttendeeOrNull,
  decryptAttendees,
  decryptPiiBlob,
  encryptAttendeeFields,
  encryptPiiBlob,
  PII_BLOB_VERSION,
  parsePiiBlob,
} from "#shared/db/attendees/pii.ts";
export {
  ATTENDEE_JOIN_SELECT,
  ATTENDEE_LEFT_JOIN_SELECT,
  getAttendee,
  getAttendeeRaw,
  getAttendeesByTokens,
  getAttendeesRaw,
  getNewestAttendeesRaw,
} from "#shared/db/attendees/queries.ts";
export { getActiveEventStats } from "#shared/db/attendees/stats.ts";

export {
  addEventLink,
  checkGroupCapAfterDurationChange,
  incrementAttachmentDownloads,
  markRefunded,
  recomputeEventBookingRanges,
  updateAttendeePII,
  updateCheckedIn,
  updateEventLink,
} from "#shared/db/attendees/update.ts";
export {
  lineKeyFromBooking,
  loadExistingLines,
  type AtomicDesiredLine,
  type ExistingLine,
  type UpdateAttendeeAtomicResult,
} from "#shared/db/attendees/atomic-update.ts";
import {
  applyAttendeeAtomicEdit as applyAttendeeAtomicEditImpl,
} from "#shared/db/attendees/atomic-update.ts";

/** Stubbable API for testing atomic operations */
export const attendeesApi = {
  applyAttendeeAtomicEdit: applyAttendeeAtomicEditImpl,
  checkBatchAvailability: checkBatchAvailabilityImpl,
  createAttendeeAtomic: createAttendeeAtomicImpl,
  hasAvailableSpots: checkEventAvailability,
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

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const createAttendeeAtomic = (
  input: AttendeeInput,
): Promise<CreateAttendeeResult> => attendeesApi.createAttendeeAtomic(input);

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const checkBatchAvailability = (
  items: BatchAvailabilityItem[],
  date?: string | null,
): Promise<boolean> => attendeesApi.checkBatchAvailability(items, date);
