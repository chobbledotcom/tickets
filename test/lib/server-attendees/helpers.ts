import { expect } from "@std/expect";
import { handleRequest } from "#routes";
import type { Answer, Question } from "#shared/db/question-types.ts";
import { getAttendeeAnswersBatch } from "#shared/db/questions/attendee-answers/reads.ts";
import { saveAttendeeAnswers } from "#shared/db/questions/attendee-answers/save.ts";
import { setListingQuestions } from "#shared/db/questions/queries.ts";
import { answersTable, questionsTable } from "#shared/db/questions/tables.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import {
  adminFormPost,
  awaitTestRequest,
  buildAttendeeEditForm,
  createTestAttendee,
  createTestAttendeeDirect,
  createTestListing,
  expectFlash,
  expectHtmlResponse,
  FLASH_TEST_ID,
  flashCookieHeader,
  getAttendeesRaw,
  mockFormRequest,
} from "#test-utils";

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

/** Like `setupListingAndAttendee` but creates the attendee directly via
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

/** The first attendee from a `createTestAttendeeAtomic`-style result,
 *  throwing (loudly, like the tests it replaces) when booking failed. */
export const firstAttendee = (
  result:
    | { success: true; attendees: Attendee[] }
    | { success: false; reason: string },
): Attendee => {
  if (!result.success) {
    throw new Error(`Failed to create attendee: ${result.reason}`);
  }
  return result.attendees[0]!;
};

/** Load a page with a flash cookie carrying `message` and assert the message
 *  renders. Shared by the add-attendee and attendee-edit "listing page shows
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
 *  provider and `isPaymentRefunded` stubbed to answer `isRefunded` per
 *  reference. Returns the response and every reference the route asked the
 *  provider about, in call order — the shared mock dance behind both the
 *  fixed-answer refresh tests and the per-reference balance-refresh tests. */
export const refreshPaymentWithStripe = async (
  attendeeId: number,
  isRefunded: (reference: string) => Promise<boolean>,
): Promise<{ response: Response; queriedReferences: string[] }> => {
  let response = new Response();
  const queriedReferences: string[] = [];
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
        (reference: string) => {
          queriedReferences.push(reference);
          return isRefunded(reference);
        },
      );
      try {
        response = (
          await adminFormPost(`/admin/attendees/${attendeeId}/refresh-payment`)
        ).response;
      } finally {
        mockRefunded.restore();
      }
    },
  );
  return { queriedReferences, response };
};

/** POST `/admin/attendees/:id/refresh-payment` with `isPaymentRefunded`
 *  answering `refunded` for every reference. The three Stripe refresh tests
 *  share this shape; `refundCheckArgs` carries the first reference queried so
 *  a test can confirm the payment id was passed. */
export const refreshPaymentAsStripe = async (
  attendeeId: number,
  refunded: boolean,
): Promise<{ response: Response; refundCheckArgs: unknown[] }> => {
  const { response, queriedReferences } = await refreshPaymentWithStripe(
    attendeeId,
    () => Promise.resolve(refunded),
  );
  return { refundCheckArgs: queriedReferences.slice(0, 1), response };
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
  const answers = await getAttendeeAnswersBatch([attendeeId], {
    texts: false,
  });
  return answers.get(attendeeId) ?? [];
};

/** Save one answer id for a single attendee (the one-answer setup shared by
 *  the attendee-questions pre-select and clear tests). */
export const saveAttendeeAnswer = async (
  attendeeId: number,
  answerId: number,
): Promise<void> => {
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
 *  by the attendee-edit "keeps every path" and merge "take_source on one
 *  path" tests. */
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
