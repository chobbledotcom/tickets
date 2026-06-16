import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
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
  expectRedirect,
  followRedirectWithFlash,
  submitMultiTicketForm,
} from "#test-utils";

const TERMS = "You must accept the rules.";

/** Submit a booking that fails validation, then follow the PRG redirect with
 * its flash cookie so the warm-isolate form stash re-fills the page. Returns
 * the re-rendered HTML. */
const submitAndRefill = async (
  slug: string,
  data: Record<string, string>,
): Promise<string> => {
  const posted = await submitMultiTicketForm(slug, data);
  expectRedirect(posted);
  const refilled = await followRedirectWithFlash(posted, (req) =>
    handleRequest(req),
  );
  return refilled.text();
};

/**
 * A failed booking PRG-redirects, and the follow-up GET must re-fill everything
 * the visitor entered (via the form stash) — the standard fields through
 * renderFields, and the bespoke booking controls through their savedFormValue
 * restores. Each test keeps the target field valid and trips a *different* error.
 */
describeWithEnv("server (booking input preservation)", { db: true }, () => {
  test("re-fills the cart quantities and contact details", async () => {
    await settings.update.terms(TERMS);
    const a = await createTestListing({ maxQuantity: 5, name: "Alpha" });
    const b = await createTestListing({ maxQuantity: 5, name: "Bravo" });

    // Quantities + contact are valid; terms are not agreed → terms error.
    const html = await submitAndRefill(`${a.slug}+${b.slug}`, {
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${a.id}`]: "3",
      [`quantity_${b.id}`]: "0",
    });

    expect(html).toContain("You must agree to the terms and conditions");
    expect(html).toContain('value="3" selected'); // Alpha keeps 3
    expect(html).toContain('value="0" selected'); // Bravo keeps 0
    expect(html).toContain("Jane Doe");
    expect(html).toContain("jane@example.com");
  });

  test("re-fills a custom pay-what-you-want price", async () => {
    await settings.update.terms(TERMS);
    const listing = await createTestListing({
      canPayMore: true,
      maxPrice: 5000,
      maxQuantity: 5,
      name: "Donation",
      unitPrice: 1000,
    });

    const html = await submitAndRefill(listing.slug, {
      [`custom_price_${listing.id}`]: "25.00",
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${listing.id}`]: "1",
    });
    expect(html).toContain('value="25.00"');
  });

  test("re-fills the chosen date for a daily listing", async () => {
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

    const html = await submitAndRefill(listing.slug, {
      date,
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${listing.id}`]: "1",
    });
    expect(html).toContain(`value="${date}" selected`);
  });

  test("re-fills the chosen number of days for a customisable listing", async () => {
    await settings.update.terms(TERMS);
    const listing = await createTestListing({
      customisableDays: true,
      dayPrices: { 1: 1000, 2: 2000 },
      durationDays: 2,
      maxQuantity: 5,
      name: "Workshop",
    });

    const html = await submitAndRefill(listing.slug, {
      day_count: "2",
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${listing.id}`]: "1",
    });
    expect(html).toContain('value="2" selected');
  });

  test("re-fills a question answer", async () => {
    await settings.update.terms(TERMS);
    const listing = await createTestListing({ maxQuantity: 5, name: "Ticket" });
    const question = await questionsTable.insert({ text: "Size?" });
    const answer = await answersTable.insert({
      questionId: question.id,
      sortOrder: 0,
      text: "Large",
    });
    await setListingQuestions(listing.id, [question.id]);

    const html = await submitAndRefill(listing.slug, {
      email: "jane@example.com",
      name: "Jane Doe",
      [`question_${question.id}`]: String(answer.id),
      [`quantity_${listing.id}`]: "1",
    });
    expect(html).toContain(`value="${answer.id}" checked`);
  });

  test("keeps the terms box ticked when another field fails", async () => {
    await settings.update.terms(TERMS);
    const listing = await createTestListing({ maxQuantity: 5, name: "Ticket" });

    // Terms agreed, but no quantity selected → "select at least one" error.
    const html = await submitAndRefill(listing.slug, {
      agree_terms: "1",
      email: "jane@example.com",
      name: "Jane Doe",
      [`quantity_${listing.id}`]: "0",
    });
    expect(html).toContain("Please select at least one ticket");
    expect(html).toContain('name="agree_terms" value="1" checked');
  });
});
