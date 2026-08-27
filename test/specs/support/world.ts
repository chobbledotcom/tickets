// jscpd:ignore-start
import type { World } from "@cucumber/cucumber";
import type { ChargeMoney } from "#payment/resources.ts";
import type { CleanupTask } from "#scripts/cleanup.ts";
import type { EvidencePages } from "#scripts/specs/evidence/pages.ts";
import type { ApiAnswer } from "#test/specs/support/booking-api.ts";
import type { ThingForSale } from "#test/specs/support/bundles.ts";
import type { DoorAnswer } from "#test/specs/support/door.ts";
import type {
  PutsThingsBack,
  RemembersThings,
  ThingKind,
  ThingsByKind,
} from "#test/specs/support/memory.ts";
import type {
  BookingAttempt,
  OrderInHand,
} from "#test/specs/support/public-booking.ts";
import type { RefundLedgerFault } from "#test/specs/support/refund-safety/faults.ts";
import type { RefundSafetyState } from "#test/specs/support/refund-safety/state.ts";
import type {
  CodeOnScreen,
  WhereTheCodeLed,
} from "#test/specs/support/shown-code.ts";
import { withEnv } from "#test-utils/env.ts";
import type { RecordedFetchCall } from "#test-utils/mocks.ts";
import type {
  JourneyCatalogSpec,
  OrderJourneyCtx,
} from "#test-utils/order-journey.ts";
// jscpd:ignore-end

/** Something a story does, told which one to do it to. The three below differ
 * only in what that second word means — the name of a thing for sale, a
 * person, or an amount of money — and saying which keeps an exported helper
 * from calling a person's name a listing's. */
export type ActOnOneThing = (
  world: TicketsWorld,
  name: string,
) => Promise<void>;
/** A step that names nothing at all: it acts on the story as it stands. */
export type ActOnTheStory = (world: TicketsWorld) => Promise<void>;

export type ActOnOnePerson = (
  world: TicketsWorld,
  who: string,
) => Promise<void>;
export type ActOnSomeMoney = (
  world: TicketsWorld,
  amount: string,
) => Promise<void>;

/** Something a story reads back about one of the things the site sells — a
 * page's words, a downloaded file, what an organiser was told, the address of
 * the link that leads into it. Readers that hand back several answers rather
 * than one say so: `ReadAboutOneThing<string[]>`. */
export type ReadAboutOneThing<Answer = string> = (
  world: TicketsWorld,
  name: string,
) => Promise<Answer>;

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

/** Turns "the thing, or nothing" into a plain yes or no, so a story can ask
 * whether the site still offers something without repeating the lookup. */
export type AsksAboutOneThing = (
  world: TicketsWorld,
  name: string,
) => Promise<boolean>;

export const asksIfThereIs =
  <Found>(
    look: (world: TicketsWorld, name: string) => Promise<Found | null>,
  ): AsksAboutOneThing =>
  async (world, name) =>
    (await look(world, name)) !== null;

export interface TicketsWorld extends World, EvidencePages {
  apiAnswer?: ApiAnswer;
  apiFirstDay?: string;
  apiKeyAnswer?: { answered: number; said: string };
  apiKeyPageAnswer?: number;
  apiKeyShownOnce?: string;
  apiKeyTakeBack?: string;
  apiKeyWrite?: number;
  apiListing?: string;
  apiRoomAnswer?: boolean;
  attendeeEmail?: string;
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
  buyerQuestion?: { id: number; text: string };
  cashBefore?: number;
  cleanup: PutsThingsBack;
  closedDayOn?: string;
  codeLedTo?: WhereTheCodeLed;
  confirmName?: string;
  daysOfferedLastLook?: string;
  doorAnswer?: DoorAnswer;
  duplicateId?: number;
  duplicateToken?: string;
  editorAnswer?: number;
  editorInvite?: string;
  firstBody?: string;
  firstDay?: string;
  firstFailureData?: string;
  firstStatus?: number;
  /** What the SMS gateway answers in this story, when it is not the ordinary
   * "it took the message". A new answer each time it is asked, because a
   * story that sends twice would read one body twice. */
  gatewayReply?: () => Response;
  groupSlug?: string;
  holdListingId?: number;
  lengthChangeMessage?: string;
  listingDetail?: { id: number; name: string };
  listingId?: number;
  mergeOutcome?: { applied: boolean; message: string };
  mergePreviewHtml?: string;
  messagesOut?: {
    calls: RecordedFetchCall[];
    emailCall: () => RecordedFetchCall | undefined;
  };
  /** The words somebody last wrote into a message box, kept so a later step
   * can prove those words — not just any words — were what got sent. */
  messageWritten?: string;
  modifierId?: number;
  moneyFault?: RefundLedgerFault;
  newStayLength?: number;
  orderCatalogSpec?: JourneyCatalogSpec;
  orderCtx?: OrderJourneyCtx;
  orderDay?: string;
  orderFilledIn?: OrderInHand;
  orderSent?: BookingAttempt;
  placeholderId?: number;
  providerCharges: Map<string, ChargeMoney>;
  questionChoices?: { byLabel: Record<string, string>; field: string };
  questionId?: number;
  raceListing?: string;
  raceLoser?: BookingAttempt;
  raceWinners?: number;
  refundCalls?: () => number;
  refundSafety?: RefundSafetyState;
  secondBody?: string;
  secondStatus?: number;
  servicingEventId?: number;
  sessionId?: string;
  sharedDayLimit?: number;
  sharedDayOver?: string;
  shownCode?: CodeOnScreen;
  signedInEditorName?: string;
  stayStartsOn?: string;
  things: RemembersThings;
  ticketToken?: string;
  wordsWritten?: string;
  writeoffBefore?: number;
}

/** Run the rest of this scenario with the environment changed, and put it
 * back when the scenario ends. Every story that needs a different environment
 * goes through here, so none of them can leave one behind for the next. */
export const scenarioEnv = (
  world: Pick<TicketsWorld, "cleanup">,
  changes: Record<string, string | undefined>,
): void => {
  world.cleanup.add(withEnv(changes));
};

export const addDatabaseCleanup = (
  world: Pick<TicketsWorld, "cleanup">,
  cleanupDb: CleanupTask,
  clearEncryptionKey: CleanupTask,
): void => {
  world.cleanup.add(clearEncryptionKey, cleanupDb);
};

/** Something a story does to the site: told the world it works in and
 * whatever else that journey needs, answering with words — a price summary,
 * what the site said — or with nothing at all. */
export type StoryJourney<Args extends unknown[], Answer> = (
  world: TicketsWorld,
  ...args: Args
) => Promise<Answer>;

/** Wrap a journey that answers with words, so the answer is kept under the
 * name the story reads it back by. The journey itself stays about doing the
 * thing; remembering what came back is this one step's job. */
export const keepsAnswerAs =
  <Args extends unknown[]>(
    name: string,
    journey: StoryJourney<Args, string>,
  ): StoryJourney<Args, void> =>
  async (world, ...args) => {
    keepWhatTheyWereTold(world, name, await journey(world, ...args));
  };

/** Reading back one kind of thing the story kept for somebody. */
export type ReadsWhatWasKept<Kind extends ThingKind> = (
  world: TicketsWorld,
  who: string,
) => ThingsByKind[Kind];

/** What the story kept for somebody, or a loud failure when it kept none —
 * their own window, the ticket they hold, what they were last told. Curried on
 * which kind of thing is being asked for, so every reader is one line and they
 * all fail the same way. */
export const whatWasKeptFor =
  <Kind extends ThingKind>(kind: Kind): ReadsWhatWasKept<Kind> =>
  (world, who) =>
    world.things.require(kind, who);

/** Keep what somebody was told the last time they did something, and read it
 * back. Every "the organiser is told …" step is one of these two halves, so
 * they live together rather than once per story. */
export const keepWhatTheyWereTold = (
  world: TicketsWorld,
  who: string,
  told: string,
): void => {
  world.things.remember("told", who, told);
};

export const whatTheyWereTold: ReadsWhatWasKept<"told"> =
  whatWasKeptFor("told");

export const requiredWorldValue = <Value>(
  value: Value | null | undefined,
  name: string,
): Value => {
  if (value === undefined || value === null) {
    throw new Error(`${name} was not set`);
  }
  return value;
};
