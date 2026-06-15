import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { addDays } from "#shared/dates.ts";
import {
  answersTable,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  createTestListing,
  describeWithEnv,
  expectBookingError,
  submitMultiTicketForm,
} from "#test-utils";

const TERMS = "You must accept the rules.";

/**
 * A validation error must re-render the booking page inline (HTTP 400) with
 * everything the visitor entered preserved — never drop their cart or details.
 * Each test keeps the target field valid and trips a *different* error.
 */
describeWithEnv("server (booking input preservation)", { db: true }, () => {
  test("preserves the cart quantities and contact details", async () => {
    await settings.update.terms(TERMS);
    const a = await createTestListing({ maxQuantity: 5, name: "Alpha" });
    const b = await createTestListing({ maxQuantity: 5, name: "Bravo" });

    // Quantities + contact are valid; terms are not agreed → terms error.
    const response = await submitMultiTicketForm(`${a.slug}+${b.slug}`, {
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${a.id}`]: "3",
      [`quantity_${b.id}`]: "0",
    });

    const html = await expectBookingError(
      response,
      "You must agree to the terms and conditions",
    );
    expect(html).toContain('value="3" selected'); // Alpha keeps 3
    expect(html).toContain('value="0" selected'); // Bravo keeps 0
    expect(html).toContain("Jane Doe");
    expect(html).toContain("jane@example.com");
  });

  test("preserves a custom pay-what-you-want price", async () => {
    await settings.update.terms(TERMS);
    const listing = await createTestListing({
      canPayMore: true,
      maxPrice: 5000,
      maxQuantity: 5,
      name: "Donation",
      unitPrice: 1000,
    });

    const response = await submitMultiTicketForm(listing.slug, {
      [`custom_price_${listing.id}`]: "25.00",
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${listing.id}`]: "1",
    });

    const html = await expectBookingError(
      response,
      "You must agree to the terms and conditions",
    );
    expect(html).toContain('value="25.00"');
  });

  test("preserves the chosen date for a daily listing", async () => {
    await settings.update.terms(TERMS);
    const date = addDays(todayInTz("UTC"), 1);
    const listing = await createTestListing({
      bookableDays: [
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ],
      listingType: "daily",
      maximumDaysAfter: 14,
      maxQuantity: 5,
      minimumDaysBefore: 0,
      name: "Day Pass",
    });

    const response = await submitMultiTicketForm(listing.slug, {
      date,
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${listing.id}`]: "1",
    });

    const html = await expectBookingError(
      response,
      "You must agree to the terms and conditions",
    );
    expect(html).toContain(`value="${date}" selected`);
  });

  test("preserves the chosen number of days for a customisable listing", async () => {
    await settings.update.terms(TERMS);
    const listing = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 2000 },
      durationDays: 2,
      maxQuantity: 5,
      name: "Workshop",
    });

    const response = await submitMultiTicketForm(listing.slug, {
      day_count: "2",
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${listing.id}`]: "1",
    });

    const html = await expectBookingError(
      response,
      "You must agree to the terms and conditions",
    );
    expect(html).toContain('value="2" selected');
  });

  test("preserves a question answer", async () => {
    await settings.update.terms(TERMS);
    const listing = await createTestListing({ maxQuantity: 5, name: "Ticket" });
    const question = await questionsTable.insert({ text: "Size?" });
    const answer = await answersTable.insert({
      questionId: question.id,
      sortOrder: 0,
      text: "Large",
    });
    await setListingQuestions(listing.id, [question.id]);

    const response = await submitMultiTicketForm(listing.slug, {
      email: "jane@example.com",
      name: "Jane Doe",
      [`question_${question.id}`]: String(answer.id),
      [`quantity_${listing.id}`]: "1",
    });

    const html = await expectBookingError(
      response,
      "You must agree to the terms and conditions",
    );
    expect(html).toContain(`value="${answer.id}" checked`);
  });

  test("keeps the terms box ticked when another field fails", async () => {
    await settings.update.terms(TERMS);
    const listing = await createTestListing({ maxQuantity: 5, name: "Ticket" });

    // Terms agreed, but no quantity selected → "select at least one" error.
    const response = await submitMultiTicketForm(listing.slug, {
      agree_terms: "1",
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${listing.id}`]: "0",
    });

    const html = await expectBookingError(
      response,
      "Please select at least one ticket",
    );
    expect(html).toContain('name="agree_terms" value="1" checked');
  });
});
