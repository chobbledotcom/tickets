import type { Attendee, Listing } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  awaitTestRequest,
  createTestAttendee,
  createTestAttendeeDirect,
  createTestListing,
  expectHtmlResponse,
  extractInputValue,
  flashCookieHeader,
  FLASH_TEST_ID,
  mockFormRequest,
} from "#test-utils";
import { handleRequest } from "#routes";
import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import type { Answer, Question } from "#shared/db/questions.ts";

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
  return { listing, attendee };
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
  return { listing, attendee, token };
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
      (opts.source ?? {}).name ?? "John Smith",
      (opts.source ?? {}).email ?? "john@example.com",
      (opts.source ?? {}).quantity,
      (opts.source ?? {}).phone,
      (opts.source ?? {}).address,
      (opts.source ?? {}).special_instructions,
    );
  return { listing1, listing2, target, source, sourceToken };
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
  const { saveAttendeeAnswers: save } = await import(
    "#shared/db/questions.ts"
  );
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
  return { response, mergeVersion };
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
