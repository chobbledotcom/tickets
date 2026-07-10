import { expect } from "@std/expect";
import type { CreateAttendeeResult } from "#shared/db/attendee-types.ts";
import { getAttendeesByTokens } from "#shared/db/attendees.ts";
import type { Answer, Question } from "#shared/db/question-types.ts";
import { getAttendeeAnswersByQuestion } from "#shared/db/questions/attendee-answers/reads.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  createPaidTestAttendee,
  createTestAttendeeDirect,
  createTestListing,
  expectFlash,
  extractInputValue,
  getListingActivityLog,
} from "#test-utils";

/** A slot for one of the optional contact fields on a direct attendee booking. */
type DirectBooking = {
  name?: string;
  email?: string;
  quantity?: number;
  phone?: string;
  address?: string;
  special_instructions?: string;
};

/** Extract merge_version from the merge preview HTML page. */
export const getMergeVersion = async (
  targetId: number,
  sourceToken: string,
): Promise<string> => {
  const page = await adminGet(
    `/admin/attendees/${targetId}/actions?token=${encodeURIComponent(
      sourceToken,
    )}`,
  );
  const html = await page.text();
  // The merge preview template always renders the merge_version hidden input,
  // so a missing value means the page itself is broken — let it fail loudly
  // downstream rather than guarding an impossible state here.
  return extractInputValue(html, "merge_version")!;
};

/** A merge pair: a "Jane Doe" target on one listing and a "John Smith" source
 *  (with its ticket token) on a second listing named "E2". Pass
 *  `sameListing` to put both on the same listing (booking conflict). Extra
 *  PII (`phone`/`address`/`special_instructions`) is forwarded to
 *  `createTestAttendeeDirect`; used by the merge-panel preview tests
 *  that exercise "source has empty phone" / "address differs" branches. */
export const mergePair = async (
  opts: {
    sameListing?: boolean;
    target?: DirectBooking;
    source?: DirectBooking;
    listingOpts?: Parameters<typeof createTestListing>[0];
  } = {},
): Promise<{
  listing1: Listing;
  listing2: Listing | null;
  target: Attendee;
  source: Attendee;
  sourceToken: string;
}> => {
  const listing1 = await createTestListing({
    maxAttendees: 10,
    ...opts.listingOpts,
  });
  const t = opts.target ?? {};
  const { attendee: target } = await createTestAttendeeDirect(
    listing1.id,
    t.name ?? "Jane Doe",
    t.email ?? "jane@example.com",
    t.quantity,
    t.phone,
    t.address,
    t.special_instructions,
  );
  const listing2 = opts.sameListing
    ? null
    : await createTestListing({ maxAttendees: 10, name: "E2" });
  const { attendee: source, token: sourceToken } =
    await createTestAttendeeDirect(
      listing2?.id ?? listing1.id,
      opts.source?.name ?? "John Smith",
      opts.source?.email ?? "john@example.com",
      opts.source?.quantity,
      opts.source?.phone,
      opts.source?.address,
      opts.source?.special_instructions,
    );
  return { listing1, listing2, source, sourceToken, target };
};

/** A `mergePair` where both listings carry the same radio question with
 *  the given answer texts (one or two answers). `a1` is always the first
 *  answer; `a2` is the second when two are passed (the merge answer-conflict
 *  tests use two; the source-only / target-only tests pass one, leaving `a2`
 *  undefined — they never read it). Used by the merge answer conflict tests. */
export const mergePairWithQuestion = async (
  questionText: string,
  answerTexts: string[],
): Promise<{
  a1: Answer;
  a2: Answer | undefined;
  listing1: Listing;
  listing2: Listing | null;
  q: Question;
  source: Attendee;
  sourceToken: string;
  target: Attendee;
}> => {
  const { listing1, listing2, target, source, sourceToken } = await mergePair();
  const q = await questionsTable.insert({
    displayType: "radio",
    text: questionText,
  });
  const answers: Answer[] = [];
  for (const [index, text] of answerTexts.entries()) {
    answers.push(
      await answersTable.insert({
        questionId: q.id,
        sortOrder: index,
        text,
      }),
    );
  }
  await setListingQuestions(listing1.id, [q.id]);
  if (listing2) await setListingQuestions(listing2.id, [q.id]);
  return {
    a1: answers[0]!,
    a2: answers[1],
    listing1,
    listing2,
    q,
    source,
    sourceToken,
    target,
  };
};

/** Save answers for the target and/or source of a merge pair. Only the side
 *  whose ids are passed is written, so "source-only" and "target-only" cases
 *  skip the other side entirely — matching the inline code it replaces. */
export const assignMergeAnswers = async (
  targetId: number,
  sourceToken: string,
  assignments: { target?: number[]; source?: number[] },
): Promise<void> => {
  if (assignments.target) {
    await saveAttendeeAnswers(new Map([[targetId, assignments.target]]));
  }
  if (assignments.source) {
    const [source] = await getAttendeesByTokens([sourceToken]);
    await saveAttendeeAnswers(new Map([[source!.id, assignments.source]]));
  }
};

/** The first attendee out of a createAttendeeAtomic result. Test setup always
 *  fits capacity, so the success arm is asserted rather than branched on (a
 *  failure would surface as the assertion blowing up downstream). */
export const attendeeOf = (result: CreateAttendeeResult): Attendee =>
  (result as Extract<CreateAttendeeResult, { success: true }>).attendees[0]!;

/** A booking-conflict pair where the discarded side carries real money: a
 *  "Jane Doe" target and a PAID "John Smith" source (3 tickets at 500, paid
 *  under `paymentId`) on the same listing. The merge's money-decision tests
 *  (credit vs write off) share this exact setup. */
export const paidConflictPair = async (
  paymentId: string,
): Promise<{ listing: Listing; target: Attendee; source: Attendee }> => {
  const listing = await createTestListing({ maxAttendees: 10, unitPrice: 500 });
  const { attendee: target } = await createTestAttendeeDirect(
    listing.id,
    "Jane Doe",
    "jane@example.com",
    1,
  );
  const source = await createPaidTestAttendee(
    listing.id,
    "John Smith",
    "john@example.com",
    paymentId,
    500,
    3,
  );
  return { listing, source, target };
};

/** Submit a merge that skips the conflicting booking and resolves its money
 *  with the given decision ("credit" or "writeoff"). Returns the response. */
export const submitMoneyMerge = async (
  listingId: number,
  targetId: number,
  sourceToken: string,
  money: "credit" | "writeoff",
): Promise<Response> => {
  const bookingKey = `${listingId}:null:0:0`;
  const { response } = await submitMerge(targetId, sourceToken, {
    [`booking_${bookingKey}`]: "skip_source",
    [`money_${bookingKey}`]: money,
  });
  return response;
};

/** Fetch the preview's merge_version, then POST the merge form with the given
 *  extra fields (`answer_<qId>`, `booking_<key>`, PII choices, …). Returns
 *  the redirect response and the version used. */
export const submitMerge = async (
  targetId: number,
  sourceToken: string,
  extra: Record<string, string> = {},
): Promise<{ response: Response; mergeVersion: string }> => {
  const mergeVersion = await getMergeVersion(targetId, sourceToken);
  const { response } = await adminFormPost(
    `/admin/attendees/${targetId}/merge`,
    { merge_version: mergeVersion, source_token: sourceToken, ...extra },
  );
  return { mergeVersion, response };
};

/** Read a merged attendee's answer for one question after a merge POST. Pass
 *  `undefined` for `expectedAnswerId` to assert the answer was cleared.
 *  File-local — only used by the merge helpers below. */
const expectMergeAnswer = async (
  targetId: number,
  questionId: number,
  expectedAnswerId: number | undefined,
): Promise<void> => {
  const finalAnswers = await getAttendeeAnswersByQuestion(targetId);
  if (expectedAnswerId === undefined) {
    expect(finalAnswers.has(questionId)).toBe(false);
  } else {
    expect(finalAnswers.get(questionId)?.answerId).toBe(expectedAnswerId);
  }
};

/** Set up a merge pair with a two-answer question, assign target=a1/source=a2
 *  (the conflict), submit the merge with the given answer `choice`
 *  ("source"/"clear"/"target"), and assert the expected outcome. The Size,
 *  Diet, and Shirt merge-conflict tests all share this exact shape. Returns the
 *  response so a caller can add extra assertions (e.g. flash). */
export const mergeWithAnswerConflict = async (
  questionText: string,
  answerTexts: [string, string],
  choice: "source" | "clear" | "target",
): Promise<Response> => {
  const { q, a1, a2, listing1, target, sourceToken } =
    await mergePairWithQuestion(questionText, answerTexts);
  await assignMergeAnswers(target.id, sourceToken, {
    source: [a2!.id],
    target: [a1.id],
  });
  const { response } = await submitMerge(target.id, sourceToken, {
    [`answer_${q.id}`]: choice,
  });
  expect(response.status).toBe(302);
  const expected =
    choice === "source" ? a2!.id : choice === "target" ? a1.id : undefined;
  await expectMergeAnswer(target.id, q.id, expected);
  // The merge summary spells out exactly what happened to the answers: an
  // adopted or cleared answer is named in the activity log, while keeping the
  // target's answer reports only the moved booking.
  if (choice === "target") {
    expectFlash(
      response,
      "Merged John Smith into Jane Doe. 1 booking(s) moved",
      true,
    );
  } else {
    const answerClause =
      choice === "source" ? "1 answer(s) from source" : "1 answer(s) cleared";
    const log = (await getListingActivityLog(listing1.id)).find((l) =>
      l.message.includes("merged into"),
    );
    expect(log?.message).toBe(
      `Attendee 'John Smith' merged into 'Jane Doe'. 1 booking(s) moved. ${answerClause}`,
    );
  }
  return response;
};

/** Set up a merge pair with a one-answer question, assign the answer to only
 *  `side` ("source"/"target"), submit the merge (no answer choice — the
 *  non-conflicting answer auto-adopts), and assert the survivor keeps the
 *  answer. The source-only and target-only merge tests share this shape. */
export const mergeNonConflictingAnswer = async (
  questionText: string,
  answerText: string,
  side: "source" | "target",
): Promise<void> => {
  const { q, a1, target, sourceToken } = await mergePairWithQuestion(
    questionText,
    [answerText],
  );
  await assignMergeAnswers(target.id, sourceToken, { [side]: [a1.id] });
  const { response } = await submitMerge(target.id, sourceToken);
  expect(response.status).toBe(302);
  await expectMergeAnswer(target.id, q.id, a1.id);
};
