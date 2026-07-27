import type { World } from "@cucumber/cucumber";
import { type CleanupTask, runCleanups } from "#scripts/cleanup.ts";
import type { Listing } from "#shared/types.ts";
import type { BookingAttempt } from "#test/specs/support/public-booking.ts";
import type {
  JourneyCatalogSpec,
  OrderJourneyCtx,
} from "#test-utils/order-journey.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

export interface TicketsWorld extends World {
  attendeeId?: number;
  attendeeIds?: number[];
  attendeeName?: string;
  backupZip?: Uint8Array;
  bookingPath?: string;
  bookingWasTaken?: boolean;
  bulkRefundMessage?: string;
  cashBefore?: number;
  cleanup: Array<() => void | Promise<void>>;
  closedDayOn?: string;
  confirmName?: string;
  customerBrowser?: TestBrowser;
  daysOffered?: Map<string, string[]>;
  daysOfferedLastLook?: string;
  duplicateId?: number;
  duplicateToken?: string;
  evidenceValues: Map<string, string>;
  firstBody?: string;
  firstDay?: string;
  firstFailureData?: string;
  firstStatus?: number;
  groupSlug?: string;
  holdListingId?: number;
  lengthChangeMessage?: string;
  listingId?: number;
  listingIds: Map<string, number>;
  mergeOutcome?: { applied: boolean; message: string };
  mergePreviewHtml?: string;
  modifierId?: number;
  newStayLength?: number;
  orderCatalogSpec?: JourneyCatalogSpec;
  orderCtx?: OrderJourneyCtx;
  orderDay?: string;
  placeholderId?: number;
  questionId?: number;
  raceListing?: string;
  raceLoser?: BookingAttempt;
  raceWinners?: number;
  refundCalls?: () => number;
  secondBody?: string;
  secondStatus?: number;
  servicingEventId?: number;
  sessionId?: string;
  sharedDayLimit?: number;
  sharedDayOver?: string;
  stayListings?: Map<string, Listing>;
  stayStartsOn?: string;
  testBrowser?: TestBrowser;
  ticketToken?: string;
  writeoffBefore?: number;
}

export const cleanupWorld = (
  world: Pick<TicketsWorld, "cleanup">,
): Promise<void> => runCleanups(world.cleanup.reverse());

export const addDatabaseCleanup = (
  world: Pick<TicketsWorld, "cleanup">,
  cleanupDb: CleanupTask,
  clearEncryptionKey: CleanupTask,
): void => {
  world.cleanup.push(clearEncryptionKey, cleanupDb);
};

export const requiredWorldValue = <Value>(
  value: Value | undefined,
  name: string,
): Value => {
  if (value === undefined) throw new Error(`${name} was not set`);
  return value;
};
