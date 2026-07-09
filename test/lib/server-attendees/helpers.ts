import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import type { Answer, Question } from "#shared/db/questions.ts";
import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  buildAttendeeEditForm,
  createTestAttendee,
  createTestAttendeeDirect,
  createTestListing,
  expectFlash,
  expectHtmlResponse,
  extractInputValue,
  FLASH_TEST_ID,
  flashCookieHeader,
  getAttendeesRaw,
  mockFormRequest,
} from "#test-utils";

/** A slot for one of the optional contact fields on a direct attendee booking. */
export type DirectBooking = {
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
  const value = extractInputValue(html, "merge_version");
  if (value === null) throw new Error("merge_version not found in page");
  return value;
};

/** A listing (100 spots by default) plus one attendee booked onto it ("John
 *  Doe" by default). The single most repeated setup across the attendee admin
 *  tests — pulled here so every delete/checkin/edit/resend test shares it. */
export const setupListingAndAttendee = async (
  opts: {
    listing?: Parameters<typeof createTestListing>[0];
    name?: string;
    email?: string;
  } = {},
): Promise<{ listing: Listing; attendee: Attendee }> => {
  const listing = await createTestListing({
    maxAttendees: 100,
    ...opts.listing,
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    opts.name ?? "John Doe",
    opts.email ?? "john@example.com",
  );
  return { attendee, listing };
};

/** Like {@link setupListingAndAttendee} but creates the attendee directly via
 *  the DB (`createTestAttendeeDirect`), returning its ticket token too. The
 *  merge-panel tests need the token (the public-route `createTestAttendee`
 *  leaves `ticket_token` unset), so they use this direct variant. */
export const setupListingAndDirectAttendee = async (
  opts: {
    listing?: Parameters<typeof createTestListing>[0];
    name?: string;
    email?: string;
  } = {},
): Promise<{ listing: Listing; attendee: Attendee; token: string }> => {
  const listing = await createTestListing({
    maxAttendees: 100,
    ...opts.listing,
  });
  const { attendee, token } = await createTestAttendeeDirect(
    listing.id,
    opts.name ?? "John Doe",
    opts.email ?? "john@example.com",
  );
  return { attendee, listing, token };
};

/** The first attendee from a {@link createTestAttendeeAtomic}-style result,
 *  throwing (loudly, like the tests it replaces) when booking failed. */
export const firstAttendee = (
  result:
    | { success: true; attendees: Attendee[] }
    | { success: false; reason: string },
): Attendee => {
  if (!result.success) throw new Error("Failed to create attendee");
  return result.attendees[0]!;
};

/** A merge pair: a "Jane Doe" target on one listing and a "John Smith" source
 *  (with its ticket token) on a second listing named "E2". Pass
 *  `sameListing` to put both on the same listing (booking conflict). Extra
 *  PII (`phone`/`address`/`special_instructions`) is forwarded to
 *  {@link createTestAttendeeDirect}; used by the merge-panel preview tests
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

/** A {@link mergePair} where both listings carry the same radio question with
 *  the given answer texts (one or two answers). `a1` is always the first
 *  answer; `a2` is the second when two are passed (the merge answer-conflict
 *  tests use two; the source-only / target-only tests pass one and ignore
 *  `a2`). Used by the merge answer conflict tests, which then assign answers
 *  to target/source and submit. */
export const mergePairWithQuestion = async (
  questionText: string,
  answerTexts: string[],
): Promise<{
  listing1: Listing;
  listing2: Listing | null;
  q: Question;
  a1: Answer;
  a2: Answer;
  target: Attendee;
  source: Attendee;
  sourceToken: string;
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
    a2: answers[1]!,
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
  const { saveAttendeeAnswers: save } = await import("#shared/db/questions.ts");
  if (assignments.target) {
    await save(new Map([[targetId, assignments.target]]));
  }
  if (assignments.source) {
    const { getAttendeesByTokens } = await import("#shared/db/attendees.ts");
    const [source] = await getAttendeesByTokens([sourceToken]);
    await save(new Map([[source!.id, assignments.source]]));
  }
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

/** Load a page with a flash cookie carrying `message` and assert the message
 *  renders. Shared by the add-attende and attendee-edit "listing page shows
 *  flash message" tests. */
export const expectFlashPage = async (
  url: string,
  cookie: string,
  message: string,
  success = true,
): Promise<void> => {
  const response = await awaitTestRequest(`${url}?flash=${FLASH_TEST_ID}`, {
    cookie: `${cookie}; ${flashCookieHeader(message, success)}`,
  });
  await expectHtmlResponse(response, 200, message);
};

/** POST the listing-scoped delete-incomplete action and return the redirect
 *  response. The four delete-incomplete tests share this exact submission. */
export const submitDeleteIncomplete = async (
  listingId: number,
  attendeeId: number,
  cookie: string,
  csrfToken: string,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/listing/${listingId}/attendee/${attendeeId}/delete-incomplete`,
      { csrf_token: csrfToken },
      cookie,
    ),
  );

/** Build the attendee edit form with `overrides` and POST it. Returns the
 *  response. Shared by the attendee-edit validation and update tests. */
export const submitAttendeeEdit = async (
  attendeeId: number,
  overrides: Parameters<typeof buildAttendeeEditForm>[1],
): Promise<Response> => {
  const form = await buildAttendeeEditForm(attendeeId, overrides);
  return (await adminFormPost(`/admin/attendees/${attendeeId}`, form)).response;
};

/** POST `/admin/attendees/:id/refresh-payment` with Stripe configured as the
 *  provider and `isPaymentRefunded` stubbed to return `refunded`. The three
 *  Stripe refresh tests share this exact mock dance. Returns the response and
 *  the args `isPaymentRefunded` was first called with (so a test can confirm
 *  the payment id was passed). */
export const refreshPaymentAsStripe = async (
  attendeeId: number,
  refunded: boolean,
): Promise<{ response: Response; refundCheckArgs: unknown[] }> => {
  let response = new Response();
  let refundCheckArgs: unknown[] = [];
  const { stub } = await import("@std/testing/mock");
  const { withMocks, mockProviderType } = await import("#test-utils");
  const { paymentsApi } = await import("#shared/payments.ts");
  await withMocks(
    () =>
      stub(paymentsApi, "getConfiguredProvider", () =>
        mockProviderType("stripe"),
      ),
    async () => {
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockRefunded = stub(
        stripePaymentProvider,
        "isPaymentRefunded",
        () => Promise.resolve(refunded),
      );
      try {
        response = (
          await adminFormPost(`/admin/attendees/${attendeeId}/refresh-payment`)
        ).response;
        refundCheckArgs = mockRefunded.calls[0]?.args ?? [];
      } finally {
        mockRefunded.restore();
      }
    },
  );
  return { refundCheckArgs, response };
};

/** A listing plus one attendee and a radio question with two answers, all
 *  attached to the listing. The shared setup for the attendee-questions edit
 *  tests. */
export const setupListingWithQuestion = async (
  questionText: string,
  a1Text: string,
  a2Text: string,
): Promise<{
  listing: Listing;
  attendee: Attendee;
  q: Question;
  a1: Answer;
  a2: Answer;
}> => {
  const listing = await createTestListing({ maxAttendees: 100 });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "John Doe",
    "john@example.com",
  );
  const q = await questionsTable.insert({
    displayType: "radio",
    text: questionText,
  });
  const a1 = await answersTable.insert({
    questionId: q.id,
    sortOrder: 0,
    text: a1Text,
  });
  const a2 = await answersTable.insert({
    questionId: q.id,
    sortOrder: 1,
    text: a2Text,
  });
  await setListingQuestions(listing.id, [q.id]);
  return { a1, a2, attendee, listing, q };
};

/** The answer ids an attendee currently has saved, in save order. */
export const attendeeAnswerIds = async (
  attendeeId: number,
): Promise<number[]> => {
  const { getAttendeeAnswersBatch } = await import("#shared/db/questions.ts");
  const answers = await getAttendeeAnswersBatch([attendeeId], {
    texts: false,
  });
  return answers.get(attendeeId) ?? [];
};

/** Read a merged attendee's answer for one question after a merge POST. Pass
 *  `undefined` for `expectedAnswerId` to assert the answer was cleared. */
export const expectMergeAnswer = async (
  targetId: number,
  questionId: number,
  expectedAnswerId: number | undefined,
): Promise<void> => {
  const { getAttendeeAnswersByQuestion } = await import(
    "#shared/db/questions.ts"
  );
  const finalAnswers = await getAttendeeAnswersByQuestion(targetId);
  if (expectedAnswerId === undefined) {
    expect(finalAnswers.has(questionId)).toBe(false);
  } else {
    expect(finalAnswers.get(questionId)?.answerId).toBe(expectedAnswerId);
  }
};

/** Submit the admin add-attendee form for `listing` with the given fields,
 *  injecting the session's CSRF token. Returns the response. */
export const submitAddAttendee = async (
  listingId: number,
  cookie: string,
  csrfToken: string,
  fields: Record<string, string>,
): Promise<Response> =>
  handleRequest(
    mockFormRequest(
      `/admin/listing/${listingId}/attendee`,
      { csrf_token: csrfToken, ...fields },
      cookie,
    ),
  );

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
  const { q, a1, a2, target, sourceToken } = await mergePairWithQuestion(
    questionText,
    answerTexts,
  );
  await assignMergeAnswers(target.id, sourceToken, {
    source: [a2.id],
    target: [a1.id],
  });
  const { response } = await submitMerge(target.id, sourceToken, {
    [`answer_${q.id}`]: choice,
  });
  expect(response.status).toBe(302);
  const expected =
    choice === "source" ? a2.id : choice === "target" ? a1.id : undefined;
  await expectMergeAnswer(target.id, q.id, expected);
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

/** Save one answer id for a single attendee (the one-answer setup shared by
 *  the attendee-questions pre-select and clear tests). */
export const saveAttendeeAnswer = async (
  attendeeId: number,
  answerId: number,
): Promise<void> => {
  const { saveAttendeeAnswers } = await import("#shared/db/questions.ts");
  await saveAttendeeAnswers(new Map([[attendeeId, [answerId]]]));
};

/** Submit an answer choice via the attendee edit form (with the standard
 *  email/name fields), assert 302, and return the attendee's resulting answer
 *  ids. Shared by the "saves selected answer" and "updates answer" tests. */
export const submitQuestionAnswer = async (
  attendeeId: number,
  questionId: number,
  answerId: number,
): Promise<number[]> => {
  const response = await submitAttendeeEdit(attendeeId, {
    email: "john@example.com",
    extra: { [`question_${questionId}`]: String(answerId) },
    name: "John Doe",
  });
  expect(response.status).toBe(302);
  return attendeeAnswerIds(attendeeId);
};

/** Query a dual-package attendee's listing_attendees rows as
 *  `[package_group_id, quantity]` pairs, sorted by package_group_id. Shared
 *  by the attendee-edit "keeps every path" and merge "take_source on one
 *  path" tests, both of which create a dual-package attendee and verify the
 *  row distribution after an edit or merge. */
export const dualPackageRows = async (
  attendeeId: number,
): Promise<[number, number][]> => {
  const { queryAll } = await import("#shared/db/client.ts");
  const rows = await queryAll<{
    package_group_id: number;
    quantity: number;
  }>(
    `SELECT package_group_id, quantity FROM listing_attendees
          WHERE attendee_id = ? ORDER BY package_group_id ASC`,
    [attendeeId],
  );
  return rows.map((row) => [Number(row.package_group_id), row.quantity]);
};

/** Create an attendee who books `listing` twice — once through `groupId`
 *  (quantity 2) and once standalone (quantity 1). The dual-path booking shared
 *  by the attendee-edit "keeps every path" and merge "take_source on one path"
 *  tests. */
export const createDualPackageAttendee = async (
  listingId: number,
  groupId: number,
  name: string,
  email: string,
): Promise<Attendee> => {
  const { createAttendeeAtomic } = await import("#shared/db/attendees.ts");
  const made = await createAttendeeAtomic({
    bookings: [
      { listingId, packageGroupId: groupId, quantity: 2 },
      { listingId, quantity: 1 },
    ],
    email,
    name,
  });
  return (made as Extract<typeof made, { success: true }>).attendees[0]!;
};

/** Assert the add-attendee response redirected with an "Added" flash and that
 *  exactly one attendee was booked onto the listing; return that attendee row
 *  for any further per-test checks (e.g. quantity). */
export const expectAttendeeAdded = async (
  response: Response,
  listingId: number,
): Promise<Awaited<ReturnType<typeof getAttendeesRaw>>[number]> => {
  expect(response.status).toBe(302);
  expectFlash(response, expect.stringContaining("Added"));
  const attendees = await getAttendeesRaw(listingId);
  expect(attendees.length).toBe(1);
  return attendees[0]!;
};
