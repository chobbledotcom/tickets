// jscpd:ignore-start
import type { World } from "@cucumber/cucumber";
import { type CleanupTask, runCleanups } from "#scripts/cleanup.ts";
import type { Group, Listing } from "#shared/types.ts";
import type { ApiAnswer } from "#test/specs/support/booking-api.ts";
import type { ThingForSale } from "#test/specs/support/bundles.ts";
import type { DoorAnswer } from "#test/specs/support/door.ts";
import type { BookingAttempt } from "#test/specs/support/public-booking.ts";
import type {
  CodeOnScreen,
  WhereTheCodeLed,
} from "#test/specs/support/shown-code.ts";
import type {
  JourneyCatalogSpec,
  OrderJourneyCtx,
} from "#test-utils/order-journey.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

/** Something a story does, told which one to do it to. The three below differ
 * only in what that second word means — the name of a thing for sale, a
 * person, or an amount of money — and saying which keeps an exported helper
 * from calling a person's name a listing's. */
export type ActOnOneThing = (
  world: TicketsWorld,
  name: string,
) => Promise<void>;
export type ActOnOnePerson = (
  world: TicketsWorld,
  who: string,
) => Promise<void>;
export type ActOnSomeMoney = (
  world: TicketsWorld,
  amount: string,
) => Promise<void>;

/** Something a story reads back about one of the things the site sells — a
 * page's words, a downloaded file, what an organiser was told. */
export type ReadAboutOneThing = (
  world: TicketsWorld,
  name: string,
) => Promise<string>;

/** The listing a money story is working on, and the booking on it. Both are
 * set up before any step that uses them, so a story that lost one is a story
 * that went wrong rather than one with nothing to talk about. */
export const theListing = (world: TicketsWorld): number =>
  requiredWorldValue(world.listingId, "the listing");
export const theBooking = (world: TicketsWorld): number =>
  requiredWorldValue(world.attendeeId, "the booking");

/** Something a story changes about one of the things the site sells, where the
 * change itself is a choice the person makes — a day to stop opening on, an
 * address to forward to, whether it sells on its own. */
export type ChangeOneThing<Choice> = (
  world: TicketsWorld,
  name: string,
  choice: Choice,
) => Promise<void>;

/** The record a story just looked up, or a loud failure when the site no longer
 * has it. A story that carried on with nothing would report the wrong thing:
 * "it forwards nowhere" reads the same as "the listing was destroyed". */
export const stillThere = <Found>(
  found: Found | null | undefined,
  name: string,
): Found => {
  if (!found) throw new Error(`The ${name} is gone altogether`);
  return found;
};

export interface TicketsWorld extends World {
  apiAnswer?: ApiAnswer;
  apiFirstDay?: string;
  apiKeyAnswer?: { answered: number; said: string };
  apiKeyPageAnswer?: number;
  apiKeyShownOnce?: string;
  apiKeys?: Map<string, string>;
  apiKeyTakeBack?: string;
  apiKeyWrite?: number;
  apiListing?: string;
  apiRoomAnswer?: boolean;
  attendeeId?: number;
  attendeeIds?: number[];
  attendeeName?: string;
  backupZip?: Uint8Array;
  bookingPath?: string;
  bookingWasTaken?: boolean;
  bulkRefundMessage?: string;
  bundleBookingPage?: string;
  bundleOutcome?: string;
  bundleParts?: ThingForSale[];
  bundles?: Map<string, Group>;
  bundleTicketPath?: string;
  cashBefore?: number;
  cleanup: Array<() => void | Promise<void>>;
  closedDayOn?: string;
  codeLedTo?: WhereTheCodeLed;
  confirmName?: string;
  customerBrowser?: TestBrowser;
  daysOffered?: Map<string, string[]>;
  daysOfferedLastLook?: string;
  doorAnswer?: DoorAnswer;
  doorTickets?: Map<string, string>;
  duplicateId?: number;
  duplicateToken?: string;
  editorAnswer?: number;
  editorBrowser?: TestBrowser;
  editorInvite?: string;
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
  shownCode?: CodeOnScreen;
  signedInEditorName?: string;
  sitePageTold?: string;
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
