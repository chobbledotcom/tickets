import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import { setChildIds } from "#shared/db/listing-parents.ts";
import {
  answersTable,
  getAttendeeAnswersBatch,
  questionsTable,
  setListingQuestions,
} from "#shared/db/questions.ts";
import {
  createDailyTestListing,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectFlash,
  getTicketCsrfToken,
} from "#test-utils";

/** Fetch the GET booking-page HTML for `slugs`. */
const ticketPageHtml = async (slugs: string): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const res = await handleRequest(mockRequest(`/ticket/${slugs}`));
  return res.text();
};

/** GET a `/ticket/<slugs>` page, returning the page HTML and its CSRF token. */
const ticketPageToken = async (slugs: string): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const res = await handleRequest(mockRequest(`/ticket/${slugs}`));
  const token = getTicketCsrfToken(await res.text());
  if (!token) throw new Error(`no CSRF token for /ticket/${slugs}`);
  return token;
};

/** POST a booking to `/ticket/<slugs>` with the given fields (CSRF auto-added). */
const postBooking = async (
  slugs: string,
  fields: Record<string, string>,
): Promise<Response> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const csrf = await ticketPageToken(slugs);
  return handleRequest(
    mockFormRequest(
      `/ticket/${slugs}`,
      { csrf_token: csrf, ...fields },
      `csrf_token=${csrf}`,
    ),
  );
};

/** POST a `/calculate` quote, returning the rendered HTML fragment. */
const postCalculate = async (
  slugs: string,
  fields: Record<string, string>,
): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockFormRequest } = await import("#test-utils/mocks.ts");
  const csrf = await ticketPageToken(slugs);
  const res = await handleRequest(
    mockFormRequest(
      `/calculate/${slugs}`,
      { csrf_token: csrf, ...fields },
      `csrf_token=${csrf}`,
    ),
  );
  return res.text();
};

const expectReserved = (response: Response): void => {
  expect(response.status).toBe(302);
  expect(response.headers.get("location") ?? "").toMatch(
    /^\/ticket\/reserved\?tokens=.+$/,
  );
};

describeWithEnv(
  "server > parents booking fold (flag on)",
  { db: true, env: { LISTING_PARENTS_ENABLED: "true" }, triggers: true },
  () => {
    test("a single bookable child auto-selects and folds into a free booking", async () => {
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
        thankYouUrl: "",
      });
      const child = await createTestListing({
        maxQuantity: 5,
        name: "Add-on",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "2",
      });
      expectReserved(res);

      const parentRows = await getAttendeesRaw(parent.id);
      const childRows = await getAttendeesRaw(child.id);
      expect(parentRows.length).toBe(1);
      expect(parentRows[0]?.quantity).toBe(2);
      // Child quantity follows the parent (invariant I2).
      expect(childRows.length).toBe(1);
      expect(childRows[0]?.quantity).toBe(2);
    });

    test("a multi-child parent rejects when no child is chosen", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const childA = await createTestListing({ name: "Add-on A" });
      const childB = await createTestListing({ name: "Add-on B" });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Please choose an option for Base unit.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a multi-child parent accepts the chosen child and folds only it", async () => {
      const parent = await createTestListing({
        name: "Base unit",
        thankYouUrl: "",
      });
      const childA = await createTestListing({ name: "Add-on A" });
      const childB = await createTestListing({ name: "Add-on B" });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
        [`child_${parent.id}`]: String(childB.id),
      });
      expectReserved(res);
      expect((await getAttendeesRaw(childB.id)).length).toBe(1);
      // The unchosen sibling is never booked.
      expect((await getAttendeesRaw(childA.id)).length).toBe(0);
    });

    test("a submitted child that is not a child of the parent is rejected", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      const stranger = await createTestListing({ name: "Stranger" });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
        [`child_${parent.id}`]: String(stranger.id),
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Please choose an option for Base unit.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a parent with no bookable child is rejected (sold out)", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      // A child with no capacity is not bookable, so the parent is sold out.
      const child = await createTestListing({
        maxAttendees: 0,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Base unit has no available options right now.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("child fields under a zero-quantity parent are ignored, not rejected", async () => {
      const parentA = await createTestListing({ name: "Base A" });
      const childA = await createTestListing({ name: "Add-on A" });
      await setChildIds(parentA.id, [childA.id]);
      const plain = await createTestListing({ name: "Plain" });

      // Book only the plain listing; the no-JS baseline submits parentA's child
      // controls at quantity 0 — they must be dropped, not fail the booking.
      const slugs = `${parentA.slug}+${plain.slug}`;
      const res = await postBooking(slugs, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parentA.id}`]: "0",
        [`quantity_${plain.id}`]: "1",
        [`child_${parentA.id}`]: String(childA.id),
      });
      expectReserved(res);
      expect((await getAttendeesRaw(plain.id)).length).toBe(1);
      // No child line was created for the un-booked parent.
      expect((await getAttendeesRaw(childA.id)).length).toBe(0);
    });

    test("a shared child under two parents sums its quantity into one line", async () => {
      const parentA = await createTestListing({
        maxQuantity: 5,
        name: "Base A",
      });
      const parentB = await createTestListing({
        maxQuantity: 5,
        name: "Base B",
      });
      const child = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 10,
        name: "Shared add-on",
      });
      await setChildIds(parentA.id, [child.id]);
      await setChildIds(parentB.id, [child.id]);

      const slugs = `${parentA.slug}+${parentB.slug}`;
      const res = await postBooking(slugs, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parentA.id}`]: "2",
        [`quantity_${parentB.id}`]: "3",
      });
      expectReserved(res);
      const childRows = await getAttendeesRaw(child.id);
      expect(childRows.length).toBe(1);
      expect(childRows[0]?.quantity).toBe(5);
    });

    test("a shared child over its capacity when summed is rejected (not clamped)", async () => {
      const parentA = await createTestListing({
        maxQuantity: 5,
        name: "Base A",
      });
      const parentB = await createTestListing({
        maxQuantity: 5,
        name: "Base B",
      });
      const child = await createTestListing({
        maxAttendees: 3,
        maxQuantity: 10,
        name: "Tight add-on",
      });
      await setChildIds(parentA.id, [child.id]);
      await setChildIds(parentB.id, [child.id]);

      const res = await postBooking(`${parentA.slug}+${parentB.slug}`, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parentA.id}`]: "2",
        [`quantity_${parentB.id}`]: "2",
      });
      expect(res.status).toBe(302);
      expectFlash(res, undefined, false);
      expect((await getAttendeesRaw(parentA.id)).length).toBe(0);
    });

    test("a pay-more child's submitted price is folded into the order", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        canPayMore: true,
        maxPrice: 5000,
        name: "Donation add-on",
        unitPrice: 1000,
      });
      await setChildIds(parent.id, [child.id]);

      // The quote (no provider) surfaces the amount owed, which must include the
      // chosen pay-more child price (30.00), proving the child folded in.
      const html = await postCalculate(parent.slug, {
        [`quantity_${parent.id}`]: "1",
        [`child_${parent.id}`]: String(child.id),
        [`child_price_${parent.id}_${child.id}`]: "30.00",
      });
      expect(html).toContain("£30");
    });

    test("a shared pay-more child with mismatched prices is rejected", async () => {
      const parentA = await createTestListing({
        maxQuantity: 5,
        name: "Base A",
      });
      const parentB = await createTestListing({
        maxQuantity: 5,
        name: "Base B",
      });
      const child = await createTestListing({
        canPayMore: true,
        maxAttendees: 100,
        maxPrice: 9000,
        maxQuantity: 10,
        name: "Shared donation",
        unitPrice: 1000,
      });
      await setChildIds(parentA.id, [child.id]);
      await setChildIds(parentB.id, [child.id]);

      const res = await postBooking(`${parentA.slug}+${parentB.slug}`, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parentA.id}`]: "1",
        [`quantity_${parentB.id}`]: "1",
        [`child_price_${parentA.id}_${child.id}`]: "20.00",
        [`child_price_${parentB.id}_${child.id}`]: "30.00",
      });
      expect(res.status).toBe(302);
      expectFlash(res, undefined, false);
      expect((await getAttendeesRaw(child.id)).length).toBe(0);
    });

    test("an order needing two distinct customisable durations is rejected", async () => {
      // A customisable page listing booked at 2 days, alongside a fixed-3-day
      // parent whose customisable child must inherit 3 days — the single
      // CheckoutIntent.dayCount can't represent both, so reject.
      const pageCustom = await createTestListing({
        customisableDays: true,
        dayPrices: { 2: 2000, 3: 3000 },
        durationDays: 3,
        name: "Customisable page item",
      });
      const parent = await createDailyTestListing({
        durationDays: 3,
        name: "3-day base",
      });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 2: 2000, 3: 3000 },
        durationDays: 3,
        name: "Customisable add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const parentRow = (await getListingWithCount(parent.id))!;
      const date = getBookableStartDates(
        parentRow,
        await getActiveHolidays(),
      )[0]!;

      const res = await postBooking(`${pageCustom.slug}+${parent.slug}`, {
        date,
        day_count: "2",
        email: "a@b.com",
        name: "Ada",
        [`quantity_${pageCustom.id}`]: "1",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, undefined, false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a pay-more child below its minimum price is rejected", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        canPayMore: true,
        maxPrice: 5000,
        name: "Donation add-on",
        unitPrice: 1000,
      });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
        [`child_${parent.id}`]: String(child.id),
        [`child_price_${parent.id}_${child.id}`]: "1.00",
      });
      expect(res.status).toBe(302);
      expectFlash(res, undefined, false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a customisable child inherits the fixed daily parent's duration", async () => {
      // A fixed 3-day daily parent; its customisable child must be priced and
      // booked for 3 days (the parent's resolved duration), not the default 1.
      const parent = await createDailyTestListing({
        durationDays: 3,
        name: "3-day base",
      });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        maxPrice: 0,
        name: "Customisable add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const parentRow = (await getListingWithCount(parent.id))!;
      const date = getBookableStartDates(
        parentRow,
        await getActiveHolidays(),
      )[0]!;

      // The quote owes the child's 3-day price (30.00), not its 1-day price.
      const html = await postCalculate(parent.slug, {
        date,
        [`quantity_${parent.id}`]: "1",
      });
      expect(html).toContain("£30");
    });

    test("a customisable parent's child folds at the parent's chosen duration", async () => {
      // The parent is customisable; its standard child folds dateless and the
      // parent's resolved duration is the buyer's chosen day_count.
      const parent = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        name: "Customisable base",
      });
      const child = await createTestListing({
        name: "Add-on",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(parent.slug, {
        day_count: "2",
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expect((await getAttendeesRaw(parent.id)).length).toBe(1);
      // The child folded as an ordinary (dateless) line of quantity 1.
      const childRows = await getAttendeesRaw(child.id);
      expect(childRows.length).toBe(1);
      expect(childRows[0]?.quantity).toBe(1);
    });

    test("the /calculate quote includes the auto-selected child", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        maxPrice: 0,
        name: "Paid add-on",
        unitPrice: 1500,
      });
      await setChildIds(parent.id, [child.id]);

      // Parent is free, child costs 15.00 — the quote must reflect the child.
      const html = await postCalculate(parent.slug, {
        [`quantity_${parent.id}`]: "1",
      });
      expect(html).toContain("£15");
    });

    test("a selected child's question is parsed and saved against its line", async () => {
      const parent = await createTestListing({
        name: "Base unit",
        thankYouUrl: "",
      });
      const child = await createTestListing({
        name: "Add-on",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [child.id]);
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      const answer = await answersTable.insert({
        questionId: question.id,
        sortOrder: 0,
        text: "Large",
      });
      await setListingQuestions(child.id, [question.id]);

      // The child question renders once, non-required, in the parent page.
      const html = await ticketPageHtml(parent.slug);
      const occurrences =
        html.split(`name="question_${question.id}"`).length - 1;
      expect(occurrences).toBe(1);
      expect(html).not.toContain(`name="question_${question.id}" required`);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`question_${question.id}`]: String(answer.id),
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(res);
      const childRows = await getAttendeesRaw(child.id);
      const batch = await getAttendeeAnswersBatch([childRows[0]!.id], {
        texts: false,
      });
      expect(batch.get(childRows[0]!.id)).toEqual([answer.id]);
    });

    test("a required child question missing for the selected child rejects", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Size?",
      });
      await answersTable.insert({
        questionId: question.id,
        sortOrder: 0,
        text: "Large",
      });
      await setListingQuestions(child.id, [question.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, undefined, false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a question shared by sibling children renders once; a page question stays required", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const childA = await createTestListing({ name: "Add-on A" });
      const childB = await createTestListing({ name: "Add-on B" });
      await setChildIds(parent.id, [childA.id, childB.id]);

      // A page-level question on the parent (renders required in the main block),
      // plus a question assigned to BOTH children (renders once, non-required).
      const pageQ = await questionsTable.insert({
        displayType: "radio",
        text: "Parent question?",
      });
      await answersTable.insert({
        questionId: pageQ.id,
        sortOrder: 0,
        text: "Yes",
      });
      await setListingQuestions(parent.id, [pageQ.id]);

      const sharedQ = await questionsTable.insert({
        displayType: "radio",
        text: "Shared child question?",
      });
      await answersTable.insert({
        questionId: sharedQ.id,
        sortOrder: 0,
        text: "Maybe",
      });
      await setListingQuestions(childA.id, [sharedQ.id]);
      await setListingQuestions(childB.id, [sharedQ.id]);

      const html = await ticketPageHtml(parent.slug);
      // Page question renders required.
      expect(html).toContain(`name="question_${pageQ.id}" required`);
      // Shared child question renders exactly once and non-required.
      const sharedCount =
        html.split(`name="question_${sharedQ.id}"`).length - 1;
      expect(sharedCount).toBe(1);
      expect(html).not.toContain(`name="question_${sharedQ.id}" required`);
    });

    test("a child's all-deactivated choice question is dropped from the page", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);

      const question = await questionsTable.insert({
        displayType: "radio",
        text: "Dead question?",
      });
      // The only answer is deactivated, so the question is not answerable and
      // must not render a control a buyer can't satisfy.
      await answersTable.insert({
        active: false,
        questionId: question.id,
        sortOrder: 0,
        text: "Inactive",
      });
      await setListingQuestions(child.id, [question.id]);

      const html = await ticketPageHtml(parent.slug);
      expect(html).not.toContain(`name="question_${question.id}"`);
    });

    test("a rejected multi-child submission re-fills the chosen child", async () => {
      const { handleRequest } = await import("#routes");
      const { followRedirectWithFlash, submitMultiTicketForm } = await import(
        "#test-utils"
      );
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.terms("You must accept the rules.");
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
      });
      const childA = await createTestListing({ name: "Add-on A" });
      const childB = await createTestListing({ name: "Add-on B" });
      await setChildIds(parent.id, [childA.id, childB.id]);

      // Choose childB with valid contact, but don't agree to terms → rejected
      // with the form stashed; the follow-up GET must re-fill the chosen child.
      const posted = await submitMultiTicketForm(parent.slug, {
        email: "ada@example.com",
        name: "Ada",
        [`child_${parent.id}`]: String(childB.id),
        [`quantity_${parent.id}`]: "1",
      });
      expect(posted.status).toBe(302);
      const refilled = await followRedirectWithFlash(posted, (req) =>
        handleRequest(req),
      );
      const html = await refilled.text();
      expect(html).toContain(`value="${childB.id}" checked`);
    });

    test("a parent's configured thank-you URL survives folding a child", async () => {
      const parent = await createTestListing({
        name: "Base unit",
        thankYouUrl: "https://example.com/thanks-parent",
      });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(
        "https://example.com/thanks-parent",
      );
    });

    test("an inactive child makes its parent sold out (rejected)", async () => {
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({ name: "Add-on" });
      await setChildIds(parent.id, [child.id]);
      // Deactivating the only child leaves the parent with no bookable child.
      await deactivateTestListing(child.id);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Base unit has no available options right now.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("an inactive child is skipped, leaving an active sibling to fold", async () => {
      const parent = await createTestListing({
        name: "Base unit",
        thankYouUrl: "",
      });
      const dead = await createTestListing({ name: "Dead add-on" });
      const live = await createTestListing({
        name: "Live add-on",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [dead.id, live.id]);
      await deactivateTestListing(dead.id);

      // With the inactive child skipped, the live sibling is the sole bookable
      // child and auto-selects.
      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(res);
      expect((await getAttendeesRaw(live.id)).length).toBe(1);
      expect((await getAttendeesRaw(dead.id)).length).toBe(0);
    });

    test("a daily child whose calendar excludes the submitted date is rejected", async () => {
      const { DAY_NAMES, getBookableStartDates } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({ name: "Daily base" });
      const parentRow = (await getListingWithCount(parent.id))!;
      const holidays = await getActiveHolidays();
      const parentDate = getBookableStartDates(parentRow, holidays)[0]!;
      const parentDay =
        DAY_NAMES[new Date(`${parentDate}T00:00:00Z`).getUTCDay()]!;
      // A daily child bookable on every weekday EXCEPT the parent's date day, so
      // the parent's date is not in the child's own calendar.
      const child = await createDailyTestListing({
        bookableDays: DAY_NAMES.filter((d) => d !== parentDay),
        name: "Daily add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(parent.slug, {
        date: parentDate,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Daily base has no available options right now.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a daily child that allows the submitted date folds fine", async () => {
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({
        name: "Daily base",
        thankYouUrl: "",
      });
      // The child shares the parent's full (every-day) calendar.
      const child = await createDailyTestListing({
        name: "Daily add-on",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [child.id]);

      const parentRow = (await getListingWithCount(parent.id))!;
      const date = getBookableStartDates(
        parentRow,
        await getActiveHolidays(),
      )[0]!;

      const res = await postBooking(parent.slug, {
        date,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(res);
      expect((await getAttendeesRaw(child.id)).length).toBe(1);
    });

    test("a customisable child's option label shows the inherited day price, not its unit_price", async () => {
      // A fixed-duration (standard) parent inherits duration 1; the customisable
      // child's label must show its 1-day price (10.00), never its unit_price
      // (0, which would advertise "free" while checkout charges the day price).
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000 },
        durationDays: 1,
        maxPrice: 0,
        name: "Customisable add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // The option label carries the day price, not "£0".
      expect(html).toContain("Customisable add-on (£10");
      expect(html).not.toContain("Customisable add-on (£0");
    });

    test("a customisable child under a customisable parent shows a 'from' price", async () => {
      // A customisable parent has no single render-time duration, so its
      // customisable child's label shows "from <min day price>" (15.00).
      const parent = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        name: "Customisable base",
      });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1500, 2: 2500 },
        durationDays: 2,
        maxPrice: 0,
        name: "Customisable add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain("Customisable add-on (from £15");
    });

    test("a customisable child unpriced for a fixed parent's duration shows no price", async () => {
      // The fixed daily parent inherits duration 3, but the child has no 3-day
      // price — the label omits the price rather than advertising a wrong one.
      const parent = await createDailyTestListing({
        durationDays: 3,
        name: "3-day base",
      });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 2: 2000 },
        durationDays: 2,
        maxPrice: 0,
        name: "Two-day add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // The option appears with no price suffix (no "(£" after the name).
      expect(html).toContain("Two-day add-on");
      expect(html).not.toContain("Two-day add-on (£");
      expect(html).not.toContain("Two-day add-on (from");
    });

    test("a daily child under a dateless (standard) parent is rejected", async () => {
      // The standard parent produces no date, so a daily child can never be
      // dated — the parent is treated as sold out (defensive: admin blocks this
      // edge, but the gate must not fold a child onto a null date).
      const parent = await createTestListing({ name: "Standard base" });
      const child = await createDailyTestListing({ name: "Daily add-on" });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(
        res,
        "Standard base has no available options right now.",
        false,
      );
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a customisable daily child validates its inherited span against its calendar", async () => {
      // A daily parent with a customisable daily child: the child folds only when
      // its inherited multi-day span is bookable on its own calendar.
      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        name: "Daily base",
        thankYouUrl: "",
      });
      const child = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1500, 2: 2500 },
        durationDays: 2,
        maxPrice: 0,
        name: "Daily add-on",
        thankYouUrl: "",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const parentRow = (await getListingWithCount(parent.id))!;
      const date = getBookableStartDates(
        parentRow,
        await getActiveHolidays(),
      )[0]!;

      const res = await postBooking(parent.slug, {
        date,
        day_count: "2",
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(res);
      expect((await getAttendeesRaw(child.id)).length).toBe(1);
    });

    test("a child's stricter contact field is rendered (non-required) on the parent page", async () => {
      // Parent collects only email; the child also requires phone. The buyer must
      // SEE the phone field to fill it, but it renders non-required (server-side
      // validation is authoritative for the selected child).
      const parent = await createTestListing({
        fields: "email",
        name: "Base unit",
      });
      const child = await createTestListing({
        fields: "email,phone",
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain('name="phone"');
      // The child-only field is present but not HTML-required.
      expect(html).not.toMatch(/name="phone"[^>]*\srequired/);
    });
  },
);
