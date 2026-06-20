/**
 * End-to-end coverage for the request-scoped N+1 guard.
 *
 * The data set intentionally crosses the guard threshold (25) at each relation
 * layer, then exercises real routed pages. If any page regresses to one read
 * per listing/attendee/question/answer/modifier, the request throws the guard's
 * "N+1 query detected" error instead of silently passing.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { createAttendeeAtomic } from "#shared/db/attendees.ts";
import { N_PLUS_ONE_THRESHOLD } from "#shared/db/query-log.ts";
import {
  answersTable,
  questionsTable,
  saveAttendeeAnswers,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  awaitTestRequest,
  bookAttendee,
  createTestGroup,
  createTestListing,
  describeWithEnv,
  getTestSession,
  insertModifier,
  linkModifierAnswer,
  linkModifierGroup,
  linkModifierListing,
} from "#test-utils";

const RELATION_COUNT = 30;

const range = (count: number): number[] =>
  Array.from({ length: count }, (_, index) => index);

type ProtectedFixture = {
  attendeeIds: number[];
  crowdedListingId: number;
  groupId: number;
  listingIds: number[];
  listingSlug: string;
  multiBookingAttendeeId: number;
  modifierId: number;
  questionId: number;
};

const createProtectedFixture = async (): Promise<ProtectedFixture> => {
  const group = await createTestGroup({
    maxAttendees: RELATION_COUNT * 4,
    name: "N+1 protected group",
  });
  const listings = [];
  const attendeeIds: number[] = [];
  const questionIds: number[] = [];
  const answerIds: number[] = [];

  for (const index of range(RELATION_COUNT)) {
    const listing = await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      name: `N+1 protected listing ${index}`,
      unitPrice: 1000,
    });
    listings.push(listing);

    const question = await questionsTable.insert({
      displayType: "radio",
      text: `N+1 protected question ${index}`,
    });
    questionIds.push(question.id);

    const answer = await answersTable.insert({
      questionId: question.id,
      sortOrder: 0,
      text: `N+1 protected answer ${index}`,
    });
    answerIds.push(answer.id);

    await setListingQuestions(listing.id, [question.id]);

    const booking = await bookAttendee(listing, {
      email: `n-plus-one-${index}@example.com`,
      name: `N+1 Attendee ${index}`,
      pricePaid: 1000,
      quantity: 1,
    });
    if (!booking.success) {
      throw new Error(`Failed to seed attendee ${index}: ${booking.reason}`);
    }
    attendeeIds.push(booking.attendees[0]!.id);
  }

  const crowdedListing = await createTestListing({
    groupId: group.id,
    maxAttendees: RELATION_COUNT * 2,
    name: "N+1 protected crowded listing",
    unitPrice: 1000,
  });
  const crowdedQuestion = await questionsTable.insert({
    displayType: "radio",
    text: "N+1 protected crowded question",
  });
  const crowdedAnswer = await answersTable.insert({
    questionId: crowdedQuestion.id,
    sortOrder: 0,
    text: "N+1 protected crowded answer",
  });
  await setListingQuestions(crowdedListing.id, [crowdedQuestion.id]);

  for (const index of range(RELATION_COUNT)) {
    const booking = await bookAttendee(crowdedListing, {
      email: `n-plus-one-crowded-${index}@example.com`,
      name: `N+1 Crowded Attendee ${index}`,
      pricePaid: 1000,
      quantity: 1,
    });
    if (!booking.success) {
      throw new Error(
        `Failed to seed crowded attendee ${index}: ${booking.reason}`,
      );
    }
    attendeeIds.push(booking.attendees[0]!.id);
  }

  const multiBooking = await createAttendeeAtomic({
    bookings: listings.map((listing) => ({
      listingId: listing.id,
      pricePaid: 1000,
      quantity: 1,
    })),
    email: "n-plus-one-multi@example.com",
    name: "N+1 Multi-booking Attendee",
  });
  if (!multiBooking.success) {
    throw new Error(
      `Failed to seed multi-booking attendee: ${multiBooking.reason}`,
    );
  }
  const multiBookingAttendee = multiBooking.attendees[0]!;
  attendeeIds.push(multiBookingAttendee.id);

  await saveAttendeeAnswers(
    new Map([
      ...range(RELATION_COUNT).map((index): [number, number[]] => [
        attendeeIds[index]!,
        [answerIds[index]!],
      ]),
      ...range(RELATION_COUNT).map((index): [number, number[]] => [
        attendeeIds[RELATION_COUNT + index]!,
        [crowdedAnswer.id],
      ]),
      [multiBookingAttendee.id, answerIds],
    ]),
  );

  const modifier = await insertModifier({
    name: "N+1 protected answer add-on",
    scope: "listings",
    trigger: "answer",
  });

  for (const listing of listings)
    await linkModifierListing(modifier.id, listing.id);
  for (const answerId of answerIds)
    await linkModifierAnswer(modifier.id, answerId);

  const groupModifier = await insertModifier({
    name: "N+1 protected group discount",
    scope: "groups",
  });
  await linkModifierGroup(groupModifier.id, group.id);

  return {
    attendeeIds,
    crowdedListingId: crowdedListing.id,
    groupId: group.id,
    listingIds: listings.map((listing) => listing.id),
    listingSlug: listings[0]!.slug,
    modifierId: modifier.id,
    multiBookingAttendeeId: multiBookingAttendee.id,
    questionId: questionIds[0]!,
  };
};

const expectProtectedPage = async (
  path: string,
  cookie?: string,
): Promise<void> => {
  const response = await awaitTestRequest(
    path,
    cookie ? { cookie } : undefined,
  );
  expect(response.status).toBeLessThan(500);
  await response.text();
};

describeWithEnv("e2e: N+1 guard protection", { db: true }, () => {
  test("protects relation-heavy routed pages from repeated per-row reads", async () => {
    const fixture = await createProtectedFixture();
    const { cookie } = await getTestSession();
    const [listingId] = fixture.listingIds;
    const [attendeeId] = fixture.attendeeIds;

    expect(fixture.listingIds.length).toBeGreaterThan(N_PLUS_ONE_THRESHOLD);
    expect(fixture.attendeeIds.length).toBeGreaterThan(
      N_PLUS_ONE_THRESHOLD * 2,
    );

    const adminPaths = [
      "/admin/",
      "/admin/log",
      "/admin/debug",
      "/admin/listings",
      `/admin/listing/${listingId}`,
      `/admin/listing/${fixture.crowdedListingId}`,
      `/admin/listing/${listingId}/export`,
      "/admin/attendees",
      `/admin/attendees/${attendeeId}`,
      `/admin/attendees/${fixture.multiBookingAttendeeId}`,
      `/admin/groups/${fixture.groupId}`,
      `/admin/groups/${fixture.groupId}/bulk-actions`,
      "/admin/calendar",
      "/admin/calendar/export",
      "/admin/questions",
      `/admin/questions/${fixture.questionId}/edit`,
      "/admin/modifiers",
      `/admin/modifiers/${fixture.modifierId}/edit`,
      "/admin/emails?audience=active",
    ];

    for (const path of adminPaths) await expectProtectedPage(path, cookie);
    await expectProtectedPage(`/ticket/${fixture.listingSlug}`);
  });
});
