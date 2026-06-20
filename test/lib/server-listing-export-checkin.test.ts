import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { updateCheckedIn } from "#shared/db/attendees.ts";
import {
  answersTable,
  questionsTable,
  saveAttendeeAnswers,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  adminGet,
  createTestAttendeeDirect,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

describeWithEnv("server (listing export check-in filter)", { db: true }, () => {
  /** A listing with one checked-in (AliceIn) and one not (BobOut). */
  const setup = async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Gala",
      thankYouUrl: "https://example.com",
    });
    const { attendee: alice } = await createTestAttendeeDirect(
      listing.id,
      "AliceIn",
      "alice@example.com",
    );
    await createTestAttendeeDirect(listing.id, "BobOut", "bob@example.com");
    await updateCheckedIn(alice.id, listing.id, true);
    return listing;
  };

  test("?checkin=in exports only checked-in attendees", async () => {
    const listing = await setup();
    const { response } = await adminGet(
      `/admin/listing/${listing.id}/export?checkin=in`,
    );
    const csv = await response.text();
    expect(csv).toContain("AliceIn");
    expect(csv).not.toContain("BobOut");
  });

  test("?checkin=out exports only checked-out attendees", async () => {
    const listing = await setup();
    const { response } = await adminGet(
      `/admin/listing/${listing.id}/export?checkin=out`,
    );
    const csv = await response.text();
    expect(csv).toContain("BobOut");
    expect(csv).not.toContain("AliceIn");
  });

  test("no check-in filter exports everyone", async () => {
    const listing = await setup();
    const { response } = await adminGet(`/admin/listing/${listing.id}/export`);
    const csv = await response.text();
    expect(csv).toContain("AliceIn");
    expect(csv).toContain("BobOut");
  });

  /** A listing with two attendees: Alice (a choice answer plus a free-text
   * answer) and Bob (no answers). Together they drive the answer-cell renderer
   * through every branch — choice + free-text, an unanswered free-text
   * question, a non-free-text question, and an attendee with no answers. */
  const setupFreeText = async () => {
    const listing = await createTestListing({
      maxAttendees: 100,
      name: "Gala",
    });
    const { attendee: alice } = await createTestAttendeeDirect(
      listing.id,
      "Alice",
      "alice@example.com",
    );
    await createTestAttendeeDirect(listing.id, "Bob", "bob@example.com");
    const question = await questionsTable.insert({
      displayType: "free_text",
      text: "Dietary needs?",
    });
    const choiceQuestion = await questionsTable.insert({
      displayType: "radio",
      text: "Seat?",
    });
    const aisle = await answersTable.insert({
      questionId: choiceQuestion.id,
      sortOrder: 0,
      text: "Aisle",
    });
    const unanswered = await questionsTable.insert({
      displayType: "free_text",
      text: "Allergies?",
    });
    await setListingQuestions(listing.id, [
      question.id,
      choiceQuestion.id,
      unanswered.id,
    ]);
    await saveAttendeeAnswers(
      new Map([
        [
          alice.id,
          {
            answerIds: [aisle.id],
            textAnswers: [{ questionId: question.id, text: "Coeliac" }],
          },
        ],
      ]),
    );
    return listing;
  };

  test("includes the decrypted free-text answer in the CSV export", async () => {
    const listing = await setupFreeText();
    const { response } = await adminGet(`/admin/listing/${listing.id}/export`);
    const csv = await response.text();
    expect(csv).toContain("Dietary needs?");
    expect(csv).toContain("Coeliac");
  });

  test("shows the decrypted free-text answer on the listing page", async () => {
    const listing = await setupFreeText();
    const { response } = await adminGet(`/admin/listing/${listing.id}`);
    const html = await response.text();
    expect(html).toContain("Coeliac");
  });
});
