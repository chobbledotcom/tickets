/** A real merge form kept open while another owner window starts a refund. */

// jscpd:ignore-start
import { assertArrayIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { getAttendeeOrNull } from "#db/attendees/queries.ts";
import { queryAll } from "#db/client.ts";
import { choicesForQuestion } from "#test/specs/support/form-controls/reading.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { buyFreePlaceThroughPublicPage } from "#test/specs/support/refund-safety/journeys.ts";
import {
  refundSafety,
  type SafetyBooking,
  safetyBooking,
} from "#test/specs/support/refund-safety/state.ts";
import type { StoryJourney, TicketsWorld } from "#test/specs/support/world.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { extractFormEntries } from "#test-utils/test-browser/forms.ts";
import {
  findFormByButton,
  findForms,
} from "#test-utils/test-browser/pressing.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { Attendee } from "#types";
import type { RefundWindows } from "./windows.ts";

// jscpd:ignore-end

const MERGE_BUTTON = "Merge and delete source attendee";

interface KeptMergeForm {
  readonly html: string;
  readonly values: Record<string, string>;
}

const keptForms = new WeakMap<TicketsWorld, KeptMergeForm>();

const requiredFreeAttendeeId = (world: TicketsWorld): number => {
  if (world.duplicateId === undefined) {
    throw new Error("The second Alice has not booked a free place");
  }
  return world.duplicateId;
};

const requiredPaidToken = (world: TicketsWorld): string => {
  if (world.duplicateToken === undefined) {
    throw new Error("The paid Alice has no ticket token for the merge search");
  }
  return world.duplicateToken;
};

/** An attendee record, or nothing when the id no longer resolves. */
type AttendeeOrNull = Attendee | null;

const attendeeOrNull = async (attendeeId: number) =>
  await getAttendeeOrNull(attendeeId, await getTestPrivateKey());

const attendeePair = (paidId: number, freeId: number) =>
  Promise.all([attendeeOrNull(paidId), attendeeOrNull(freeId)]);

type ActsOnPaidBooking<Args extends unknown[], Answer> = StoryJourney<
  [who: string, ...Args],
  Answer
>;

function withPaidBooking<Args extends unknown[], Answer>(
  action: (
    world: TicketsWorld,
    booking: SafetyBooking,
    ...args: Args
  ) => Promise<Answer>,
): ActsOnPaidBooking<Args, Answer> {
  return (world, who, ...args) =>
    action(world, safetyBooking(world, who), ...args);
}

const withPaidAndFreeAttendees = <Answer>(
  action: OnPaidAndFreeAttendees<Answer>,
): ActsOnPaidBooking<[], Answer> =>
  withPaidBooking(async (world, paid) => {
    const freeId = requiredFreeAttendeeId(world);
    const [paidAttendee, freeAttendee] = await attendeePair(
      paid.attendeeId,
      freeId,
    );
    return await action(world, paid, freeId, paidAttendee, freeAttendee);
  });

/** Give the second Alice a real free booking and keep the paid ticket token. */
export const buyDuplicateFreePlace: ActsOnPaidBooking<
  [listingName: string],
  void
> = withPaidBooking(async (world, paid, listingName) => {
  const paidAttendee = await getAttendeeOrNull(
    paid.attendeeId,
    await getTestPrivateKey(),
  );
  if (paidAttendee === null) {
    throw new Error(`The paid booking for ${paid.who} disappeared`);
  }
  world.duplicateToken = paidAttendee.ticket_token;
  world.duplicateId = await buyFreePlaceThroughPublicPage(
    world,
    paid.who,
    listingName,
  );
});

/** Search from the free booking's Actions page and keep its rendered merge. */
export const openMergeChoicesInSecondWindow = async (
  world: TicketsWorld,
  windows: RefundWindows,
): Promise<void> => {
  const targetId = requiredFreeAttendeeId(world);
  const browser = windows.second;
  await browser.visit("/admin/");
  await browser.clickLink("Attendees");
  const targetPath = `/admin/attendees/${targetId}`;
  const targetLink = browser.links.find(({ href }) => href === targetPath);
  if (targetLink === undefined) {
    throw new Error("The attendee list has no way into the free Alice");
  }
  await browser.visit(targetLink.href);
  await browser.clickLink("Actions");
  await fillInAndSend(browser, { token: requiredPaidToken(world) }, "Search");
  expect(browser.containsText("Merge Preview")).toBe(true);
};

const sourceChoices = (html: string): Record<string, string> =>
  Object.fromEntries(
    extractFormEntries(html)
      .map(([field]) => field)
      .filter(
        (field) =>
          field.startsWith("pii_") &&
          choicesForQuestion(html, field).includes("source"),
      )
      .map((field) => [field, "source"]),
  );

/** Keep every paid-source detail the rendered form lets the owner choose. */
export const choosePaidDetails = (
  world: TicketsWorld,
  windows: RefundWindows,
): void => {
  const form = findFormByButton(
    findForms(windows.second.currentHtml),
    MERGE_BUTTON,
  );
  const values = sourceChoices(form.body);
  for (const field of Object.keys(values)) {
    assertArrayIncludes(choicesForQuestion(form.body, field), ["source"]);
  }
  keptForms.set(world, { html: form.body, values });
};

/** The merge the second owner window kept, pressed from that same window. */
type SubmitsKeptMerge = (
  world: TicketsWorld,
  windows: RefundWindows,
) => Promise<TestBrowser>;

/** Submit exactly the merge form and source choices the owner kept open. */
export const submitKeptMerge: SubmitsKeptMerge = async (world, windows) => {
  const kept = keptForms.get(world);
  if (kept === undefined) {
    throw new Error("The owner has not chosen what the merge should keep");
  }
  const browser = windows.second;
  const current = browser.formBodyFor(MERGE_BUTTON, Object.keys(kept.values));
  if (current !== kept.html) {
    throw new Error("The merge form changed before the owner pressed it");
  }
  await fillInAndSend(browser, kept.values, MERGE_BUTTON);
  return browser;
};

interface BookingRow {
  readonly attendee_id: number;
  readonly listing_id: number;
}

interface MovedPaymentRow {
  readonly attendee_id: number;
  readonly protected_state: string;
}

/** The shape of a post-merge check: the paid booking, the free merge target,
 * and both attendee records. */
type OnPaidAndFreeAttendees<Answer> = (
  world: TicketsWorld,
  paid: SafetyBooking,
  freeId: number,
  paidAttendee: AttendeeOrNull,
  freeAttendee: AttendeeOrNull,
) => Promise<Answer>;

/** Confirm a successful merge moved the dangerous payment row onto the free
 * attendee without copying the source's legacy payment field. */
const rememberMovedPayment: OnPaidAndFreeAttendees<void> = async (
  world,
  paid,
  targetId,
  source,
  target,
) => {
  const paymentRows = await queryAll<MovedPaymentRow>(
    `SELECT attendee_id, protected_state
       FROM processed_payments
      WHERE payment_session_id = ?`,
    [paid.sessionId],
  );
  expect(source).toBeNull();
  if (target === null) throw new Error("The free merge target disappeared");
  expect(target.payment_id).toBe("");
  expect(paymentRows).toEqual([
    { attendee_id: targetId, protected_state: "unrecorded" },
  ]);
  refundSafety(world).bookings.set(paid.who, {
    ...paid,
    attendeeId: targetId,
  });
  world.attendeeId = targetId;
};

/** The step that runs the moved-payment check and keeps the target attendee
 * as the one the rest of the visitor journey must open. */
export const rememberMovedPaymentWork: ActsOnPaidBooking<[], void> =
  withPaidAndFreeAttendees(rememberMovedPayment);

/** Both attendee records and their original booking rows survived the race. */
const expectBothPresent: OnPaidAndFreeAttendees<void> = async (
  world,
  paid,
  freeId,
  paidAttendee,
  freeAttendee,
) => {
  const freeListingId = world.listingId;
  if (freeListingId === undefined) {
    throw new Error("The free Workshop listing was not remembered");
  }
  const rows = await queryAll<BookingRow>(
    `SELECT attendee_id, listing_id FROM listing_attendees
   WHERE (attendee_id = ? AND listing_id = ?)
      OR (attendee_id = ? AND listing_id = ?)
   ORDER BY attendee_id`,
    [paid.attendeeId, paid.listingId, freeId, freeListingId],
  );
  expect(paidAttendee?.name).toBe(paid.who);
  expect(freeAttendee?.name).toBe(paid.who);
  expect(rows).toHaveLength(2);
  expect(rows).toContainEqual({
    attendee_id: paid.attendeeId,
    listing_id: paid.listingId,
  });
  expect(rows).toContainEqual({
    attendee_id: freeId,
    listing_id: freeListingId,
  });
};

export const expectBothBookingsPresent: ActsOnPaidBooking<[], void> =
  withPaidAndFreeAttendees(expectBothPresent);
