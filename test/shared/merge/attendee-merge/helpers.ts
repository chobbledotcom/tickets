import {
  attendeeAccount,
  revenueAccount,
  WORLD,
} from "#shared/accounting/accounts.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { LISTING_ATTENDEE_ROW_COLS } from "#shared/db/attendees/queries.ts";
import { queryAll } from "#shared/db/client.ts";
import type { QuestionWithAnswers } from "#shared/db/question-types.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import {
  applyAttendeeMerge,
  buildAttendeeMergeDiff,
} from "#shared/merge/attendee-merge.ts";
import type {
  AttendeeMergeDecisionInput,
  AttendeeMergeDiff,
} from "#shared/merge/attendee-merge-types.ts";
import type { ContactInfo } from "#shared/types.ts";
import { bookTestAttendee, createTestListing } from "#test-utils";
import { getTestPrivateKey } from "#test-utils/crypto.ts";

/** Create a test attendee on a single listing. */
export const createAttendee = (
  listingId: number,
  name = "Alice",
  email?: string,
) => bookTestAttendee([listingId], name, email);

/** Create a test attendee booked onto several listings at once. */
export const createAttendeeOn = (
  listingIds: number[],
  name: string,
  email?: string,
) => bookTestAttendee(listingIds, name, email);

/** Get bookings for an attendee — `refunded` is projected from the ledger, the
 *  same shape production's merge loader returns. */
export const getBookings = (attendeeId: number) =>
  queryAll<{
    listing_id: number;
    start_at: string | null;
    end_at: string | null;
    quantity: number;
    checked_in: number;
    refunded: number;
    price_paid: number;
    ledger_event_group: string;
    attachment_downloads: number;
    order_token: string;
    parent_listing_id: number;
    package_group_id: number;
  }>(
    `SELECT ${LISTING_ATTENDEE_ROW_COLS}
     FROM listing_attendees
     WHERE attendee_id = ?
     ORDER BY start_at, listing_id`,
    [attendeeId],
  );

/** Create a question with answers and assign to listing */
export const createQuestionWithAnswers = async (
  listingId: number,
  questionText: string,
  answerTexts: string[],
) => {
  const q = await questionsTable.insert({
    displayType: "radio",
    text: questionText,
  });
  const answers = [];
  for (let i = 0; i < answerTexts.length; i++) {
    const a = await answersTable.insert({
      questionId: q.id,
      sortOrder: i,
      text: answerTexts[i]!,
    });
    answers.push(a);
  }
  await setListingQuestions(listingId, [q.id]);
  return { answers, question: q };
};

/** A created question paired with its answer rows. */
type QuestionSetup = Awaited<ReturnType<typeof createQuestionWithAnswers>>;

/** Wrap a created question + answers as the questions list a diff expects. */
export const oneQuestion = (
  question: QuestionSetup["question"],
  answers: QuestionSetup["answers"],
): QuestionWithAnswers[] => [{ ...question, answers }];

/** Save a single choice answer for an attendee. */
export const saveChoice = (attendeeId: number, answerId: number) =>
  saveAttendeeAnswers(new Map([[attendeeId, [answerId]]]));

/** Insert a free-text question (not yet assigned to any listing). */
export const createFreeTextQuestion = (text = "Dietary needs?") =>
  questionsTable.insert({ displayType: "free_text", text });

/** Create an Alice → Bob merge pair. By default the target is on one listing
 *  and the source on a second ("E2"); pass `sameListing` to put both on one so
 *  the source booking is a duplicate of the target's. */
export const createMergePair = async (opts: { sameListing?: boolean } = {}) => {
  const listing = await createTestListing({ maxAttendees: 10 });
  const listing2 = opts.sameListing
    ? listing
    : await createTestListing({ maxAttendees: 10, name: "E2" });
  const target = await createAttendee(listing.id, "Alice");
  const source = await createAttendee(listing2.id, "Bob");
  return { listing, listing2, source, target };
};

/** A test attendee row, as returned by {@link createAttendee}. */
type TestAttendee = Awaited<ReturnType<typeof createAttendee>>;

/** The standard PII the merge tests attach to an attendee — every field blank
 *  except the name and email each test cares about. */
export const pii = (name: string, email: string): ContactInfo => ({
  address: "",
  email,
  name,
  phone: "",
  special_instructions: "",
});

/** Build a merge diff for a source→target pair from their current bookings.
 *  PII defaults to the standard "Bob → Alice" the tests use. */
export const buildMergeDiff = async (args: {
  source: TestAttendee;
  target: TestAttendee;
  sourcePii?: ContactInfo;
  targetPii?: ContactInfo;
  questions?: QuestionWithAnswers[];
}): Promise<AttendeeMergeDiff> =>
  buildAttendeeMergeDiff(
    {
      sourceBookings: await getBookings(args.source.id),
      sourceId: args.source.id,
      sourcePii: args.sourcePii ?? pii("Bob", "bob@test.com"),
      targetBookings: await getBookings(args.target.id),
      targetId: args.target.id,
      targetPii: args.targetPii ?? pii("Alice", "alice@test.com"),
    },
    args.questions ?? [],
  );

/** Apply a merge, filling in the target's payment_id/ticket_token and a test
 *  private key so each test only supplies the parts it actually varies. */
export const applyMerge = async (args: {
  diff: AttendeeMergeDiff;
  source: TestAttendee;
  sourcePii: ContactInfo;
  target: TestAttendee;
  targetPii: ContactInfo;
  decision: AttendeeMergeDecisionInput;
}) =>
  applyAttendeeMerge({
    decision: args.decision,
    diff: args.diff,
    privateKey: await getTestPrivateKey(),
    sourceId: args.source.id,
    sourcePii: args.sourcePii,
    targetId: args.target.id,
    targetPii: {
      ...args.targetPii,
      payment_id: args.target.payment_id,
      ticket_token: args.target.ticket_token,
    },
  });

/** The parts of a decision each test varies; `version` is filled from the diff. */
type DecisionParts = Omit<AttendeeMergeDecisionInput, "version">;
const NO_CHANGES: DecisionParts = {
  answers: {},
  bookings: {},
  money: {},
  pii: {},
};

/** A `decide` callback that resolves exactly one booking conflict, one way. */
export const bookingChoice =
  (key: string, choice: "keep_target" | "take_source") =>
  (): DecisionParts => ({
    answers: {},
    bookings: { [key]: choice },
    money: {},
    pii: {},
  });

/** Build the diff for a source→target pair and apply a merge in one step. PII
 *  defaults to the standard "Bob → Alice" the tests use; pass `decide` to base
 *  the decision on the freshly-built diff, else the merge takes no overrides. */
export const runMerge = async (args: {
  source: TestAttendee;
  target: TestAttendee;
  sourcePii?: ContactInfo;
  targetPii?: ContactInfo;
  questions?: QuestionWithAnswers[];
  decide?: (diff: AttendeeMergeDiff) => DecisionParts;
}) => {
  const sourcePii = args.sourcePii ?? pii("Bob", "bob@test.com");
  const targetPii = args.targetPii ?? pii("Alice", "alice@test.com");
  const diff = await buildMergeDiff({
    source: args.source,
    sourcePii,
    target: args.target,
    targetPii,
    ...(args.questions ? { questions: args.questions } : {}),
  });
  const result = await applyMerge({
    decision: {
      ...(args.decide ? args.decide(diff) : NO_CHANGES),
      version: diff.version,
    },
    diff,
    source: args.source,
    sourcePii,
    target: args.target,
    targetPii,
  });
  return { diff, result };
};

/** Record a paid sale for one booking: a revenue sale leg plus the matching
 *  world→attendee payment leg, both tagged with `eventGroup`. */
export const postPaidSale = (args: {
  attendeeId: number;
  listingId: number;
  eventGroup: string;
  amount?: number;
  occurredAt?: string;
}) => {
  const amount = args.amount ?? 5000;
  const occurredAt = args.occurredAt ?? "2026-06-21T00:00:00.000Z";
  const attendee = attendeeAccount(args.attendeeId);
  return postTransfers([
    {
      amount,
      destination: revenueAccount(args.listingId),
      eventGroup: args.eventGroup,
      kind: "sale",
      occurredAt,
      reference: `sale-${args.eventGroup}`,
      source: attendee,
    },
    {
      amount,
      destination: attendee,
      eventGroup: args.eventGroup,
      kind: "payment",
      occurredAt,
      reference: `pay-${args.eventGroup}`,
      source: WORLD,
    },
  ]);
};

/** Save a single free-text answer for an attendee. */
export const saveTextAnswer = (
  attendeeId: number,
  questionId: number,
  text: string,
) =>
  saveAttendeeAnswers(
    new Map([
      [attendeeId, { answerIds: [], textAnswers: [{ questionId, text }] }],
    ]),
  );
