/**
 * Attendees DB barrel.
 *
 * Implementation is split across files under `./attendees/`:
 * - `attendees/pii.ts` — PII blob build/parse + encrypt/decrypt
 * - `attendees/queries.ts` — SELECT helpers + read queries
 * - `attendees/stats.ts` — aggregated active-listing statistics
 * - `attendees/capacity.ts` — availability/capacity checks
 * - `attendees/create.ts` — atomic attendee creation
 * - `attendees/delete.ts` — deletion + listing unlink
 * - `attendees/update.ts` — PII, booking, status updates
 */

import type {
  BatchAvailabilityItem,
  CreateAttendeeResult,
} from "#shared/db/attendee-types.ts";
import {
  checkBatchAvailabilityImpl,
  checkListingAvailability,
} from "#shared/db/attendees/capacity.ts";
import { createAttendeeAtomicImpl } from "#shared/db/attendees/create.ts";

export type {
  ActiveListingStats,
  AttendeeInput,
  AttendeeWithBookings,
  BatchAvailabilityItem,
  CreateAttendeeResult,
  ListingAttendeeRow,
  ListingBooking,
  UpdateAttendeePIIInput,
} from "#shared/db/attendee-types.ts";
export {
  type AtomicDesiredLine,
  type ExistingLine,
  lineKeyFromBooking,
  loadExistingLines,
  type UpdateAttendeeAtomicResult,
} from "#shared/db/attendees/atomic-update.ts";
export {
  checkLinesCapacity,
  getGroupRemainingByGroupId,
  getGroupRemainingByListingId,
  getGroupRemainingForListing,
  getListingRemainingForRange,
  type ListingCapacityRow,
} from "#shared/db/attendees/capacity.ts";
export {
  buildAttendeeInsert,
  ensureAllBookings,
  reverseOrderActivity,
} from "#shared/db/attendees/create.ts";
export { deleteAttendee } from "#shared/db/attendees/delete.ts";
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
export type {
  AttendeeSort,
  AttendeesPage,
} from "#shared/db/attendees/queries.ts";
export {
  ATTENDEE_JOIN_SELECT,
  ATTENDEE_LEFT_JOIN_SELECT,
  ATTENDEES_PAGE_SIZE,
  getAllAttendeePiiBlobs,
  getAttendee,
  getAttendeeNamesByIds,
  getAttendeePiiBlobsForListings,
  getAttendeeRaw,
  getAttendeesByIds,
  getAttendeesByTokens,
  getAttendeesPage,
  getAttendeesRaw,
  getNewestAttendeesRaw,
  LISTING_ATTENDEE_ROW_COLS,
} from "#shared/db/attendees/queries.ts";
export { getActiveListingStats } from "#shared/db/attendees/stats.ts";
export {
  checkGroupCapAfterDurationChange,
  incrementAttachmentDownloads,
  recomputeListingBookingRanges,
  updateAttendeeOrder,
  updateAttendeePII,
  updateCheckedIn,
} from "#shared/db/attendees/update.ts";

import { applyAttendeeAtomicEdit as applyAttendeeAtomicEditImpl } from "#shared/db/attendees/atomic-update.ts";

/** Stubbable API for testing atomic operations */
export const attendeesApi = {
  applyAttendeeAtomicEdit: applyAttendeeAtomicEditImpl,
  checkBatchAvailability: checkBatchAvailabilityImpl,
  createAttendeeAtomic: createAttendeeAtomicImpl,
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

/** Wrapper for test mocking - delegates to attendeesApi at runtime */
export const checkBatchAvailability = (
  items: BatchAvailabilityItem[],
  date?: string | null,
): Promise<boolean> => attendeesApi.checkBatchAvailability(items, date);
