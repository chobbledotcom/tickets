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
  createTestAttendee,
  createTestGroup,
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

/** A CSRF token for posting to `/ticket/<slugs>`. Prefer the token embedded in
 * the rendered form; when the page renders no form (e.g. a parent projected to
 * sold-out because it has no bookable child — Codex 914), fall back to a
 * freshly-minted token so the submit-side gate can still be exercised. */
const ticketPageToken = async (slugs: string): Promise<string> => {
  const { handleRequest } = await import("#routes");
  const { mockRequest } = await import("#test-utils/mocks.ts");
  const { signCsrfToken } = await import("#shared/csrf.ts");
  const res = await handleRequest(mockRequest(`/ticket/${slugs}`));
  return getTicketCsrfToken(await res.text()) ?? (await signCsrfToken());
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
  "server > parents booking fold",
  { db: true, triggers: true },
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

    test("a sole child whose cap exceeds the chosen parent qty books at the parent qty (Fix 1)", async () => {
      // Regression for Fix 1: when the sole child's cap (5) exceeds the chosen
      // parent quantity (1), the render must NOT post a fixed child quantity — that
      // would over-submit a total of 5 and the fold would reject it as 'too many'.
      // The page is informational and the fold auto-fills exactly Q (= 1).
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

      // The rendered page emits no quantity field for the sole child.
      const html = await ticketPageHtml(parent.slug);
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);

      // Booking the parent at quantity 1 succeeds (no 'too many').
      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(res);
      const childRows = await getAttendeesRaw(child.id);
      expect(childRows.length).toBe(1);
      // The fold auto-fills the sole child to the parent quantity (1), not the cap.
      expect(childRows[0]?.quantity).toBe(1);
    });

    test("the /calculate quote for a sole-child parent below the child cap succeeds (Fix 1)", async () => {
      // The live quote runs the same fold; before Fix 1 it failed identically
      // ('too many') because the form posted the child's max as the quantity.
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
        unitPrice: 1000,
      });
      const child = await createTestListing({
        maxQuantity: 5,
        name: "Add-on",
        unitPrice: 500,
      });
      await setChildIds(parent.id, [child.id]);

      const fragment = await postCalculate(parent.slug, {
        [`quantity_${parent.id}`]: "1",
      });
      // The quote succeeds (parent £10 + auto-filled child £5 = £15), not a 'too
      // many' rejection from an over-submitted child quantity.
      expect(fragment).not.toContain("Too many add-ons");
      expect(fragment).toContain("£15");
    });

    test("a sole pay-more child auto-fills and still collects its price without a posted qty (Fix 1)", async () => {
      // The informational sole-child render posts NO `child_qty_*` field, yet the
      // pay-more price input is still rendered and the fold auto-fills the child
      // to the parent quantity and charges the submitted custom price.
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
      });
      const child = await createTestListing({
        canPayMore: true,
        maxPrice: 5000,
        maxQuantity: 5,
        name: "Donation add-on",
        unitPrice: 1000,
      });
      await setChildIds(parent.id, [child.id]);

      // The quote includes the chosen pay-more child price (30.00) even though the
      // browser posts no quantity field for the sole child — auto-fill assigns Q.
      const html = await postCalculate(parent.slug, {
        [`child_price_${parent.id}_${child.id}`]: "30.00",
        [`quantity_${parent.id}`]: "1",
      });
      expect(html).toContain("£30");
    });

    test("a multi-child parent rejects when no child is chosen", async () => {
      // With several bookable children there is no auto-select, so submitting no
      // child units leaves the per-parent total at 0 — short of the parent's
      // quantity (1), so the per-unit "choose N more add-on(s)" rejection fires.
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
      expectFlash(res, "Choose 1 more add-on for Base unit.", false);
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
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expectReserved(res);
      expect((await getAttendeesRaw(childB.id)).length).toBe(1);
      // The unchosen sibling is never booked.
      expect((await getAttendeesRaw(childA.id)).length).toBe(0);
    });

    test("parent qty 1 requires exactly one child unit (a sum of 1)", async () => {
      // With two bookable children and parent quantity 1, the buyer must choose
      // exactly one child unit in total; choosing none rejects, choosing one folds.
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
        [`child_qty_${parent.id}_${childA.id}`]: "1",
      });
      expectReserved(res);
      const rowsA = await getAttendeesRaw(childA.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(1);
      expect((await getAttendeesRaw(childB.id)).length).toBe(0);
    });

    test("parent qty 2 accepts two units of one child", async () => {
      // Per-unit model: 2 of one child satisfies a parent quantity of 2 (the old
      // "one child at the parent quantity" special case).
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
        thankYouUrl: "",
      });
      const childA = await createTestListing({
        maxQuantity: 5,
        name: "Add-on A",
      });
      const childB = await createTestListing({
        maxQuantity: 5,
        name: "Add-on B",
      });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "2",
      });
      expectReserved(res);
      const rowsA = await getAttendeesRaw(childA.id);
      // One folded line of quantity 2, no line for the unchosen sibling.
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(2);
      expect((await getAttendeesRaw(childB.id)).length).toBe(0);
    });

    test("parent qty 2 accepts one of each child (two folded lines)", async () => {
      // Per-unit model: a mix of 1 of child A + 1 of child B also satisfies a
      // parent quantity of 2, folding TWO distinct attendee lines (one each).
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
        thankYouUrl: "",
      });
      const childA = await createTestListing({ name: "Add-on A" });
      const childB = await createTestListing({ name: "Add-on B" });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expectReserved(res);
      const rowsA = await getAttendeesRaw(childA.id);
      const rowsB = await getAttendeesRaw(childB.id);
      expect(rowsA.length).toBe(1);
      expect(rowsA[0]?.quantity).toBe(1);
      expect(rowsB.length).toBe(1);
      expect(rowsB[0]?.quantity).toBe(1);
    });

    test("a child total below the parent quantity is rejected (choose more)", async () => {
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
      });
      const childA = await createTestListing({ name: "Add-on A" });
      const childB = await createTestListing({ name: "Add-on B" });
      await setChildIds(parent.id, [childA.id, childB.id]);

      // Parent quantity 2 but only 1 child unit chosen → "choose 1 more add-on".
      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "2",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Choose 1 more add-on for Base unit.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a child total above the parent quantity is rejected (too many)", async () => {
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
      });
      const childA = await createTestListing({
        maxQuantity: 5,
        name: "Add-on A",
      });
      const childB = await createTestListing({
        maxQuantity: 5,
        name: "Add-on B",
      });
      await setChildIds(parent.id, [childA.id, childB.id]);

      // Parent quantity 1 but 2 child units chosen → too many.
      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
      });
      expect(res.status).toBe(302);
      expectFlash(
        res,
        "Too many add-ons chosen for Base unit — remove 1 add-on.",
        false,
      );
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a non-numeric child quantity is treated as zero (rejected as too few)", async () => {
      // A garbage `child_qty_*` value parses to 0, so a single-bookable-child
      // parent does NOT auto-select (a value was submitted) and the total falls
      // short of the parent quantity.
      const parent = await createTestListing({ name: "Base unit" });
      const childA = await createTestListing({ name: "Add-on A" });
      const childB = await createTestListing({ name: "Add-on B" });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
        [`child_qty_${parent.id}_${childA.id}`]: "abc",
      });
      expect(res.status).toBe(302);
      expectFlash(res, "Choose 1 more add-on for Base unit.", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("a positive quantity for a listing that is not a child of the parent is rejected", async () => {
      // Two bookable children, so no auto-select; a quantity submitted for a
      // stranger listing (not a child) must be rejected, never ignored — and the
      // valid total must not be reached by it.
      const parent = await createTestListing({ name: "Base unit" });
      const childA = await createTestListing({ name: "Add-on A" });
      const childB = await createTestListing({ name: "Add-on B" });
      const stranger = await createTestListing({ name: "Stranger" });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
        [`child_qty_${parent.id}_${stranger.id}`]: "1",
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
        [`child_qty_${parentA.id}_${childA.id}`]: "1",
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
        [`child_qty_${parent.id}_${child.id}`]: "1",
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
        [`child_qty_${parent.id}_${child.id}`]: "1",
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

    test("a customisable child under a non-customisable parent marks the order customisable (dayCount carried)", async () => {
      // The page listing is a FIXED 3-day daily parent — NOT customisable — so the
      // order's base `hasCustomisable` is false. Folding its customisable child
      // (which inherits the 3-day span) must flip the order to customisable, so the
      // checkout intent serializes dayCount=3 and the child is priced for 3 days
      // (£30). If folding failed to mark the order customisable, the intent would
      // drop dayCount and the webhook would reprice the child at its 1-day span
      // (£10) — so a missing dayCount on the intent is caught.
      const { setupStripe } = await import("#test-utils");
      const { stub } = await import("@std/testing/mock");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      await setupStripe();

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

      let capturedIntent:
        | import("#shared/payments.ts").CheckoutIntent
        | undefined;
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: import("#shared/payments.ts").CheckoutIntent) => {
          capturedIntent = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.test/checkout",
            sessionId: "cs_custom_child",
          });
        },
      );

      try {
        const res = await postBooking(parent.slug, {
          date,
          email: "a@b.com",
          name: "Ada",
          [`quantity_${parent.id}`]: "1",
        });
        expect(res.status).toBe(302);
        // The folded order is customisable, so the chosen span is serialized on the
        // intent (the webhook reprices the child for the inherited 3-day span).
        expect(capturedIntent?.dayCount).toBe(3);
        // The child is priced for the inherited 3 days (£30), never its 1-day £10.
        const childItem = capturedIntent?.items.find(
          (i) => i.listingId === child.id,
        );
        expect(childItem?.unitPrice).toBe(3000);
      } finally {
        mockCreate.restore();
      }
    });

    test("two customisable lines sharing one inherited duration price once, not doubled", async () => {
      // A customisable PAGE listing seeds the order's single shared duration with
      // the chosen day_count (2); its customisable child inherits the SAME 2-day
      // duration and folds at it. The order's day count must stay 2 — the one
      // shared value — never the sum of the two contributions. Both lines are
      // priced only for a 2-day span, so the quote owes parent £18 + child £25 =
      // £43. If the shared duration were accumulated (2+2=4) instead of kept, both
      // customisable lines would reprice at a 4-day span neither offers (→ £0),
      // changing the total — so a non-idempotent `recordDuration` is caught.
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

      const html = await postCalculate(parent.slug, {
        day_count: "2",
        [`quantity_${parent.id}`]: "1",
      });
      // The order owes the single 2-day span (£18 + £25 = £43), not a
      // doubled-duration reprice that prices both lines at an unpriced 4-day span.
      expect(html).toContain("£43");
      expect(html).not.toContain("£0");
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

      // Choose 1 of childB with valid contact, but don't agree to terms →
      // rejected with the form stashed; the follow-up GET must re-fill childB's
      // chosen quantity (its select restores option 1 as selected). childA is
      // submitted with a garbage value, which the re-render restores as 0.
      const posted = await submitMultiTicketForm(parent.slug, {
        email: "ada@example.com",
        name: "Ada",
        [`child_qty_${parent.id}_${childA.id}`]: "xyz",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
        [`quantity_${parent.id}`]: "1",
      });
      expect(posted.status).toBe(302);
      const refilled = await followRedirectWithFlash(posted, (req) =>
        handleRequest(req),
      );
      const html = await refilled.text();
      // childB's per-unit select restores quantity 1; childA's garbage value
      // restores as 0 (the parsed-fallback branch).
      const selectB = html.slice(
        html.indexOf(`name="child_qty_${parent.id}_${childB.id}"`),
      );
      const optionsB = selectB.slice(0, selectB.indexOf("</select>"));
      expect(optionsB).toContain('value="1" selected');
      const selectA = html.slice(
        html.indexOf(`name="child_qty_${parent.id}_${childA.id}"`),
      );
      const optionsA = selectA.slice(0, selectA.indexOf("</select>"));
      expect(optionsA).toContain('value="0" selected');
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

    test("a paid parent's thank-you URL is carried into the checkout intent", async () => {
      // The paid path folds a required paid child, making the order
      // multi-listing; the webhook's single-listing thank-you derivation would
      // drop the parent's URL, so it must be set explicitly on the intent
      // (Codex 742). Capture the intent handed to the provider and assert it.
      const { setupStripe } = await import("#test-utils");
      const { stub } = await import("@std/testing/mock");
      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      await setupStripe();

      const parent = await createTestListing({
        maxAttendees: 50,
        name: "Base unit",
        thankYouUrl: "https://example.com/thanks-parent",
        unitPrice: 1000,
      });
      const child = await createTestListing({
        maxAttendees: 50,
        name: "Add-on",
        unitPrice: 1000,
      });
      await setChildIds(parent.id, [child.id]);

      let capturedIntent:
        | import("#shared/payments.ts").CheckoutIntent
        | undefined;
      const mockCreate = stub(
        stripePaymentProvider,
        "createCheckoutSession",
        (intent: import("#shared/payments.ts").CheckoutIntent) => {
          capturedIntent = intent;
          return Promise.resolve({
            checkoutUrl: "https://stripe.test/checkout",
            sessionId: "cs_parent_paid",
          });
        },
      );

      try {
        const res = await postBooking(parent.slug, {
          email: "a@b.com",
          name: "Ada",
          [`quantity_${parent.id}`]: "1",
        });
        expect(res.status).toBe(302);
        // The order folded the child (two distinct listings) yet still carries
        // the parent's configured thank-you URL.
        const listingIds = new Set(
          capturedIntent?.items.map((i) => i.listingId),
        );
        expect(listingIds.size).toBe(2);
        expect(capturedIntent?.thankYouUrl).toBe(
          "https://example.com/thanks-parent",
        );
      } finally {
        mockCreate.restore();
      }
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
      // The date the only child can't serve is no longer offered by the parent's
      // selector (Codex 758, constrainDatesByChildUnion), so it fails the
      // date-validation gate before the fold — still a rejection, no parent row.
      expectFlash(res, "Please select a valid date", false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    test("the fold rejects a daily child's excluded date on a multi-listing page", async () => {
      // On a multi-listing page the per-parent date-union constraint is NOT
      // applied (it would wrongly strip dates a sibling page listing needs), so
      // the child-excluded date IS offered and reaches the submit fold, which
      // rejects it because the parent then has no bookable child for that date.
      const { DAY_NAMES, getBookableStartDates } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({ name: "Daily base" });
      const plain = await createDailyTestListing({ name: "Daily plain" });
      const parentRow = (await getListingWithCount(parent.id))!;
      const holidays = await getActiveHolidays();
      const parentDate = getBookableStartDates(parentRow, holidays)[0]!;
      const parentDay =
        DAY_NAMES[new Date(`${parentDate}T00:00:00Z`).getUTCDay()]!;
      const child = await createDailyTestListing({
        bookableDays: DAY_NAMES.filter((d) => d !== parentDay),
        name: "Daily add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const res = await postBooking(`${parent.slug}+${plain.slug}`, {
        date: parentDate,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
        [`quantity_${plain.id}`]: "0",
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

    test("a daily child full on one date still folds for a parent booking on another", async () => {
      // A 1-capacity daily child is fully booked on day A. Its date-less
      // `isSoldOut` aggregate reads true, but a parent booking on day B (where
      // the child still has capacity) must fold the child fine — the date-less
      // flag must not block a daily child (Codex 336). A booking on day A is
      // still rejected, by the folded per-date availability check.
      const { bookAttendee } = await import("#test-utils");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({
        name: "Daily base",
        thankYouUrl: "",
      });
      const child = await createDailyTestListing({
        maxAttendees: 1,
        name: "Daily add-on",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [child.id]);

      const childRow = (await getListingWithCount(child.id))!;
      const dates = getBookableStartDates(childRow, await getActiveHolidays());
      const [dayA, dayB] = [dates[0]!, dates[1]!];

      // Fill the child's single spot on day A.
      const booked = await bookAttendee(child, { date: dayA });
      expect(booked.success).toBe(true);

      // A parent booking on day B folds the child fine (it has day-B capacity).
      const okRes = await postBooking(parent.slug, {
        date: dayB,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(okRes);
      const childOnB = (await getAttendeesRaw(child.id)).filter(
        (r) => r.date === dayB,
      );
      expect(childOnB.length).toBe(1);

      // A parent booking on day A is rejected — the child is genuinely full there.
      const fullRes = await postBooking(parent.slug, {
        date: dayA,
        email: "b@c.com",
        name: "Bea",
        [`quantity_${parent.id}`]: "1",
      });
      expect(fullRes.status).toBe(302);
      expectFlash(fullRes, undefined, false);
      // The rejected day-A attempt added no parent row; only the day-B booking
      // created one (its date confirms day A was never reserved for the parent).
      const parentRows = await getAttendeesRaw(parent.id);
      expect(parentRows.length).toBe(1);
      expect(parentRows[0]?.date).toBe(dayB);
    });

    // Fix 2: don't apply the date-less GROUP cap to a daily parent's children. A
    // daily parent's group is type-homogeneous (group members share listing_type),
    // so any co-grouped child is itself daily — and a daily listing is excluded
    // from the date-less group aggregate (its cap is per-date), so it is never
    // pre-marked sold out by another date's bookings. Its per-date group capacity
    // is the date-aware checkBatchAvailability's job at submit. (A *standard*
    // child can't share a daily parent's group at all — the homogeneity rule
    // blocks it — so the date-less-clamp state parents.md Fix 2 describes is
    // unreachable; these tests lock in the correct date-A/date-B behavior.)
    test("a daily parent + daily child in a group full on one date still book on a free date", async () => {
      const { bookAttendee } = await import("#test-utils");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
      const parent = await createDailyTestListing({
        groupId: group.id,
        name: "Daily base",
        thankYouUrl: "",
      });
      const filler = await createDailyTestListing({
        groupId: group.id,
        name: "Daily filler",
        thankYouUrl: "",
      });
      const child = await createDailyTestListing({
        groupId: group.id,
        name: "Daily add-on",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [child.id]);

      const parentRow = (await getListingWithCount(parent.id))!;
      const dates = getBookableStartDates(parentRow, await getActiveHolidays());
      const [dayA, dayB] = [dates[0]!, dates[1]!];

      // Fill the group's two spots on date A via the daily filler.
      const booked = await bookAttendee(filler, { date: dayA, quantity: 2 });
      expect(booked.success).toBe(true);

      // A parent booking on date B folds the daily child and reserves — date A's
      // cumulative bookings do not clamp the child date-lessly (Fix 2).
      const okRes = await postBooking(parent.slug, {
        date: dayB,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(okRes);
      expect(
        (await getAttendeesRaw(child.id)).filter((r) => r.date === dayB).length,
      ).toBe(1);
      expect(
        (await getAttendeesRaw(parent.id)).filter((r) => r.date === dayB)
          .length,
      ).toBe(1);
    });

    test("a daily parent + daily child are still rejected on a genuinely full date", async () => {
      // The date-aware checkBatchAvailability must still reject the parent+child
      // on a date whose shared group is full, so deferring does not oversell.
      const { bookAttendee } = await import("#test-utils");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
      const parent = await createDailyTestListing({
        groupId: group.id,
        name: "Daily base",
        thankYouUrl: "",
      });
      const filler = await createDailyTestListing({
        groupId: group.id,
        name: "Daily filler",
        thankYouUrl: "",
      });
      const child = await createDailyTestListing({
        groupId: group.id,
        name: "Daily add-on",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [child.id]);

      const parentRow = (await getListingWithCount(parent.id))!;
      const dates = getBookableStartDates(parentRow, await getActiveHolidays());
      const dayA = dates[0]!;

      // Fill date A's two group spots with the daily filler.
      const booked = await bookAttendee(filler, { date: dayA, quantity: 2 });
      expect(booked.success).toBe(true);

      const fullRes = await postBooking(parent.slug, {
        date: dayA,
        email: "b@c.com",
        name: "Bea",
        [`quantity_${parent.id}`]: "1",
      });
      expect(fullRes.status).toBe(302);
      expectFlash(fullRes, undefined, false);
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
      expect((await getAttendeesRaw(child.id)).length).toBe(0);
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
      // The sole child renders informationally; its label carries the day price,
      // not "£0".
      expect(html).toContain("Customisable add-on");
      expect(html).toContain("(£10");
      expect(html).not.toContain("(£0");
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
      expect(html).toContain("Customisable add-on");
      expect(html).toContain("(from £15");
    });

    test("a 'from' price uses the parent∩child spans, not the child's lowest", async () => {
      // The parent can only offer a 3-day span; the child is priced 1 day £10,
      // 3 days £25. The label must show the price for a span the parent can
      // actually book (£25), not the child's own cheapest span (£10) the parent
      // can never select (Codex 398).
      const parent = await createTestListing({
        customisableDays: true,
        dayPrices: { 3: 5000 },
        durationDays: 3,
        name: "Three-day base",
      });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 2500 },
        durationDays: 3,
        maxPrice: 0,
        name: "Customisable add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain("(from £25");
      expect(html).not.toContain("(from £10");
    });

    test("a 'from' price is omitted when parent and child spans don't overlap", async () => {
      // The parent offers only a 3-day span; the child is priced only for 1 day.
      // With no overlapping span the label omits the price entirely (the edge
      // isn't bookable anyway).
      const parent = await createTestListing({
        customisableDays: true,
        dayPrices: { 3: 5000 },
        durationDays: 3,
        name: "Three-day base",
      });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000 },
        durationDays: 1,
        maxPrice: 0,
        name: "One-day add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain("One-day add-on");
      expect(html).not.toContain("One-day add-on (from");
      expect(html).not.toContain("One-day add-on (£");
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

    test("a fixed daily child whose duration differs from the chosen span is rejected; the matching span folds", async () => {
      // A customisable daily parent offering 1 or 3 days, with a fixed 3-day
      // daily child. A 1-day booking can't fold the 3-day child (its span would
      // not match the parent's), so the parent is sold out; a 3-day booking
      // folds the child fine (Codex 449).
      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 3: 3000 },
        durationDays: 3,
        name: "Daily base",
        thankYouUrl: "",
      });
      const child = await createDailyTestListing({
        durationDays: 3,
        name: "Three-day add-on",
        thankYouUrl: "",
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

      const rejected = await postBooking(parent.slug, {
        date,
        day_count: "1",
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expect(rejected.status).toBe(302);
      expectFlash(
        rejected,
        "Daily base has no available options right now.",
        false,
      );
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);

      const ok = await postBooking(parent.slug, {
        date,
        day_count: "3",
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(ok);
      expect((await getAttendeesRaw(child.id)).length).toBe(1);
    });

    test("a parent's pay-more children render non-required price inputs", async () => {
      // The no-JS baseline emits a price input for EVERY pay-more child of a
      // parent; none may be HTML-required or the browser blocks submit demanding
      // a price for an unselected child (Codex 379).
      const parent = await createTestListing({ name: "Base unit" });
      const childA = await createTestListing({
        canPayMore: true,
        maxPrice: 5000,
        name: "Donation A",
        unitPrice: 1000,
      });
      const childB = await createTestListing({
        canPayMore: true,
        maxPrice: 5000,
        name: "Donation B",
        unitPrice: 1000,
      });
      // A bookable but NON-pay-more sibling must get no price input at all.
      const fixedChild = await createTestListing({
        name: "Fixed add-on",
        unitPrice: 1000,
      });
      await setChildIds(parent.id, [childA.id, childB.id, fixedChild.id]);

      const html = await ticketPageHtml(parent.slug);
      // The child block is wrapped in its labelled fieldset (a broken string
      // concatenation would emit "NaN" in place of the opening tag).
      expect(html).toContain(
        `<fieldset class="child-selector" data-parent-id="${parent.id}">`,
      );
      // Both pay-more child price inputs are present but neither is HTML-required.
      expect(html).toContain(`name="child_price_${parent.id}_${childA.id}"`);
      expect(html).toContain(`name="child_price_${parent.id}_${childB.id}"`);
      // The non-pay-more bookable child renders its per-unit quantity select but
      // NO price input (the pay-more input is gated on the child's own
      // can_pay_more, not merely its bookability).
      expect(html).toContain(`name="child_qty_${parent.id}_${fixedChild.id}"`);
      expect(html).not.toContain(
        `name="child_price_${parent.id}_${fixedChild.id}"`,
      );
      expect(html).not.toMatch(
        new RegExp(
          `name="child_price_${parent.id}_${childA.id}"[^>]*\\srequired`,
        ),
      );
      expect(html).not.toMatch(
        new RegExp(
          `name="child_price_${parent.id}_${childB.id}"[^>]*\\srequired`,
        ),
      );
    });

    test("only the active child is selectable; the inactive one renders disabled", async () => {
      // The render must mirror the server's active check: an inactive child is
      // rendered as a disabled (fixed-0) quantity control and never selectable,
      // leaving the lone active child as the sole bookable option — which, being
      // the only bookable child, renders informational (auto-filled by the fold)
      // and posts NO quantity field of its own (Fix 1).
      const parent = await createTestListing({ name: "Base unit" });
      const liveChild = await createTestListing({ name: "Live add-on" });
      const deadChild = await createTestListing({ name: "Dead add-on" });
      await setChildIds(parent.id, [liveChild.id, deadChild.id]);
      await deactivateTestListing(deadChild.id);

      const html = await ticketPageHtml(parent.slug);
      // The active child is the sole bookable option, so it is informational and
      // posts no `child_qty_*` field (the fold auto-fills it to the parent qty).
      expect(html).not.toContain(
        `name="child_qty_${parent.id}_${liveChild.id}"`,
      );
      expect(html).toContain(`data-sole-child="${liveChild.id}"`);
      // The inactive child renders a disabled select fixed at 0 and is never
      // a selectable quantity control.
      expect(html).toMatch(
        new RegExp(
          `<select name="child_qty_${parent.id}_${deadChild.id}"[^>]*\\sdisabled`,
        ),
      );
    });

    test("a multi-child parent renders a per-unit quantity select and a 'choose N in total' note", async () => {
      // Each bookable child gets its own quantity select (0..cap), and a note
      // tells the buyer how many add-ons to choose in total (the parent's max).
      const parent = await createTestListing({
        maxQuantity: 2,
        name: "Base unit",
      });
      const childA = await createTestListing({
        maxQuantity: 2,
        name: "Add-on A",
      });
      const childB = await createTestListing({
        maxQuantity: 2,
        name: "Add-on B",
      });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const html = await ticketPageHtml(parent.slug);
      // Both children get a per-unit quantity select; neither is forced/hidden.
      expect(html).toContain(
        `<select name="child_qty_${parent.id}_${childA.id}"`,
      );
      expect(html).toContain(
        `<select name="child_qty_${parent.id}_${childB.id}"`,
      );
      // The select offers 0..2 (the parent's effective max).
      const selectA = html.slice(
        html.indexOf(`name="child_qty_${parent.id}_${childA.id}"`),
      );
      const optionsA = selectA.slice(0, selectA.indexOf("</select>"));
      expect(optionsA).toContain('value="2"');
      expect(optionsA).not.toContain('value="3"');
      // The "choose N in total" note names the parent's quantity (2).
      expect(html).toContain("Choose 2 add-ons in total");
    });

    test("a sole pay-more child auto-fills and still renders its price input", async () => {
      // The single-bookable-child path is informational (no quantity field, Fix 1)
      // but still renders a pay-more child's non-required price input so a buyer
      // can name a price without choosing.
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        canPayMore: true,
        maxPrice: 5000,
        name: "Donation add-on",
        unitPrice: 1000,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // No `child_qty_*` is posted for the sole child (the fold auto-fills it).
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);
      // The pay-more price input is still rendered.
      expect(html).toContain(`name="child_price_${parent.id}_${child.id}"`);
    });

    test("a sole bookable child renders informational with no submitted quantity field (Fix 1)", async () => {
      // A sole bookable child must NOT post a fixed quantity (it would over-submit
      // when the parent qty is below the child's cap and the fold would reject it
      // as 'too many'). It renders informational; the fold auto-fills Q.
      const parent = await createTestListing({
        maxQuantity: 5,
        name: "Base unit",
      });
      const child = await createTestListing({
        maxQuantity: 5,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // No quantity field of any kind (hidden or select) is emitted for the sole
      // child, so nothing is posted for it and the fold's auto-fill assigns Q.
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);
      // It is shown informationally instead.
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).toContain("Includes Add-on");
    });

    test("a daily parent offers only dates its only child can serve", async () => {
      // The daily parent is bookable every day, but its only (daily) child is
      // bookable on a single weekday. The rendered date selector must offer only
      // the child's dates (parentDates ∩ child union), never a parent-only date
      // the submit fold would reject (Codex 758).
      const { DAY_NAMES, getBookableStartDates } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({ name: "Daily base" });
      const parentRow = (await getListingWithCount(parent.id))!;
      const holidays = await getActiveHolidays();
      const parentDates = getBookableStartDates(parentRow, holidays);
      const childDate = parentDates[0]!;
      const childDay =
        DAY_NAMES[new Date(`${childDate}T00:00:00Z`).getUTCDay()]!;
      // A daily child bookable only on the first parent date's weekday.
      const child = await createDailyTestListing({
        bookableDays: [childDay],
        name: "Daily add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const childRow = (await getListingWithCount(child.id))!;
      const childDates = getBookableStartDates(childRow, holidays);
      const otherDate = parentDates.find((d) => !childDates.includes(d))!;

      const html = await ticketPageHtml(parent.slug);
      // Every child date is offered; a parent-only date is not.
      for (const d of childDates) {
        expect(html).toContain(`<option value="${d}"`);
      }
      expect(html).not.toContain(`<option value="${otherDate}"`);
    });

    test("a daily parent with a dateless child keeps all its dates", async () => {
      // A STANDARD (dateless) child imposes no date constraint, so the parent
      // keeps every one of its own bookable dates (Codex 758).
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({ name: "Daily base" });
      const child = await createTestListing({ name: "Standard add-on" });
      await setChildIds(parent.id, [child.id]);

      const parentRow = (await getListingWithCount(parent.id))!;
      const parentDates = getBookableStartDates(
        parentRow,
        await getActiveHolidays(),
      );

      const html = await ticketPageHtml(parent.slug);
      for (const d of parentDates) {
        expect(html).toContain(`<option value="${d}"`);
      }
    });

    test("a customisable parent offers only day counts its child can serve", async () => {
      // The parent prices {1,2} days; its only child prices only 2 days. The
      // rendered day-count selector must offer only the 2-day option — the
      // 1-day option the submit fold would reject is gone (Codex 1030).
      const parent = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        name: "Customisable base",
      });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 2: 2500 },
        durationDays: 2,
        maxPrice: 0,
        name: "Two-day add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // The day-count options carry a "<n> day(s)" label; only the 2-day option
      // survives (the bare `<option value="1">` of the quantity selector is not a
      // day-count option, so assert on the labelled day option).
      expect(html).toContain(">2 days");
      expect(html).not.toContain(">1 day");
    });

    test("a customisable parent keeps day counts a child supports both of", async () => {
      // The child prices both 1 and 2 days, so the parent keeps both options
      // (the union covers every parent span) — Codex 1030.
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
        name: "Flexible add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain(">1 day");
      expect(html).toContain(">2 days");
    });

    test("a customisable parent's day counts are constrained to a fixed daily child's own span", async () => {
      // The parent offers {1,2,3} days; its only required child is a FIXED 2-day
      // daily listing, whose supported span is exactly its duration_days (2). The
      // day-count selector must therefore offer only the 2-day option — a daily
      // child must NOT be treated as imposing "any" span (which would keep all of
      // {1,2,3}), it constrains to its own fixed duration (childSupportedSpans).
      const parent = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
        durationDays: 3,
        name: "Customisable base",
      });
      const child = await createDailyTestListing({
        durationDays: 2,
        name: "Fixed two-day add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // Only the child's own 2-day span is offered; the 1- and 3-day options the
      // child cannot serve are dropped from the union.
      expect(html).toContain(">2 days");
      expect(html).not.toContain(">1 day");
      expect(html).not.toContain(">3 days");
    });

    test("a multi-listing page does NOT constrain the shared day counts by one parent's child", async () => {
      // The day-count union constraint is SINGLE-listing only: on a multi-listing
      // page the day-count selector is shared, so a parent's restrictive child must
      // not remove a span a sibling page listing still needs (the per-parent
      // constraint is deferred to JS + the submit fold). Page = a customisable
      // parent (child supports only 2 days) PLUS a plain customisable listing
      // offering {1,2}: the shared selector must keep BOTH the 1- and 2-day options.
      const parent = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        name: "Customisable base",
      });
      const child = await createTestListing({
        customisableDays: true,
        dayPrices: { 2: 2500 },
        durationDays: 2,
        maxPrice: 0,
        name: "Two-day add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);
      const sibling = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1200, 2: 2000 },
        durationDays: 2,
        name: "Sibling listing",
      });

      const html = await ticketPageHtml(`${parent.slug}+${sibling.slug}`);
      // Both options survive: the multi-listing page is not constrained by the
      // parent's 2-day-only child (which on its own page would drop the 1-day).
      expect(html).toContain(">1 day");
      expect(html).toContain(">2 days");
    });

    test("a daily parent builds its date union from SELECTABLE children only", async () => {
      // ACTIVE child bookable only Monday, INACTIVE child bookable only Tuesday.
      // The inactive child must contribute NOTHING to the union, so only Monday
      // is offered — its Tuesday must never become selectable (Fix 2).
      const { DAY_NAMES, getBookableStartDates } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({ name: "Daily base" });
      const parentRow = (await getListingWithCount(parent.id))!;
      const holidays = await getActiveHolidays();
      const parentDates = getBookableStartDates(parentRow, holidays);
      const mondayDate = parentDates[0]!;
      const tuesdayDate = parentDates.find((d) => d !== mondayDate)!;
      const mondayName =
        DAY_NAMES[new Date(`${mondayDate}T00:00:00Z`).getUTCDay()]!;
      const tuesdayName =
        DAY_NAMES[new Date(`${tuesdayDate}T00:00:00Z`).getUTCDay()]!;

      const activeChild = await createDailyTestListing({
        bookableDays: [mondayName],
        name: "Active add-on",
      });
      const inactiveChild = await createDailyTestListing({
        bookableDays: [tuesdayName],
        name: "Inactive add-on",
      });
      await setChildIds(parent.id, [activeChild.id, inactiveChild.id]);
      await deactivateTestListing(inactiveChild.id);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain(`<option value="${mondayDate}"`);
      // The inactive child's Tuesday must NOT be offered.
      expect(html).not.toContain(`<option value="${tuesdayDate}"`);
    });

    test("a fixed-span daily parent drops a child date with no valid full-span start", async () => {
      // A fixed 3-day parent with a customisable child priced for 3 days but
      // bookable only on Mondays: a 3-day span starting Monday needs Mon+Tue+Wed
      // all bookable for the child, which it is not, so Monday must NOT be offered
      // (Fix 3: the union validates the inherited fixed span with
      // isBookingRangeValid, not single-day starts).
      const { DAY_NAMES, getBookableStartDates } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({
        durationDays: 3,
        name: "Fixed 3-day base",
      });
      const parentRow = (await getListingWithCount(parent.id))!;
      const holidays = await getActiveHolidays();
      const parentDates = getBookableStartDates(parentRow, holidays);
      const mondayDate = parentDates[0]!;
      const mondayName =
        DAY_NAMES[new Date(`${mondayDate}T00:00:00Z`).getUTCDay()]!;

      const child = await createDailyTestListing({
        bookableDays: [mondayName],
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
        durationDays: 3,
        maxPrice: 0,
        name: "Mon-only add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // No Monday→Wednesday span is valid for the child, so Monday is not offered.
      expect(html).not.toContain(`<option value="${mondayDate}"`);
    });

    test("a customisable daily parent offers a fixed daily child's full-span starts, not single days", async () => {
      // The parent is CUSTOMISABLE daily (no fixed span at render). For a daily
      // child the union must use the child's OWN bookable START dates
      // (getBookableStartDates), which for a FIXED 3-day daily child are the days a
      // whole 3-day span fits — NOT the parent dates filtered by a single day. The
      // child is bookable only Mon+Tue+Wed: a 3-day span fits only from Monday, but
      // each of Mon/Tue/Wed is bookable as a single day. The correct render offers
      // Monday only; swapping to the fixed-span branch (which, with no fixed span,
      // degrades to a single-day validity filter) would also offer Tuesday — so the
      // branch swap is caught by Tuesday's absence.
      const { DAY_NAMES, getBookableStartDates } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
        durationDays: 3,
        name: "Customisable daily base",
      });
      const parentRow = (await getListingWithCount(parent.id))!;
      const holidays = await getActiveHolidays();
      const parentDates = getBookableStartDates(parentRow, holidays);
      const monIdx = DAY_NAMES.indexOf("Monday");
      const tueIdx = DAY_NAMES.indexOf("Tuesday");
      // A Monday in the parent's dates and the Tuesday in the parent's dates that
      // immediately follows it (so both are genuinely offerable parent dates).
      const mondayDate = parentDates.find(
        (d) => new Date(`${d}T00:00:00Z`).getUTCDay() === monIdx,
      )!;
      const tuesdayDate = parentDates.find(
        (d) =>
          new Date(`${d}T00:00:00Z`).getUTCDay() === tueIdx && d > mondayDate,
      )!;

      // A FIXED 3-day daily child bookable only on Mon/Tue/Wed: only a Monday
      // start fits a whole 3-day Mon-Tue-Wed span.
      const child = await createDailyTestListing({
        bookableDays: ["Monday", "Tuesday", "Wednesday"],
        durationDays: 3,
        name: "Mon-Wed add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // Monday (a valid full 3-day child start) is offered.
      expect(html).toContain(`<option value="${mondayDate}"`);
      // Tuesday is bookable single-day but starts no full 3-day span, so the
      // customisable parent must NOT offer it.
      expect(html).not.toContain(`<option value="${tuesdayDate}"`);
    });

    test("a customisable parent builds its day-count union from SELECTABLE children only", async () => {
      // An INACTIVE 1-day child must contribute no spans (and must not preserve
      // every parent span via its "any" null result); the ACTIVE 2-day child
      // alone drives the union, so only the 2-day option renders (Fix 4).
      const parent = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1000, 2: 1800 },
        durationDays: 2,
        name: "Customisable base",
      });
      const inactiveOneDay = await createTestListing({
        maxPrice: 0,
        name: "Inactive 1-day add-on",
        unitPrice: 0,
      });
      const activeTwoDay = await createTestListing({
        customisableDays: true,
        dayPrices: { 2: 2500 },
        durationDays: 2,
        maxPrice: 0,
        name: "Active 2-day add-on",
        unitPrice: 0,
      });
      await setChildIds(parent.id, [inactiveOneDay.id, activeTwoDay.id]);
      await deactivateTestListing(inactiveOneDay.id);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain(">2 days");
      expect(html).not.toContain(">1 day");
    });

    test("a daily child full on one date does not make its parent render sold out", async () => {
      // A 1-capacity daily child fully booked on one date reads date-less
      // isSoldOut=true, but the parent page must still render a bookable form —
      // the daily child is potentially bookable on the dates it still has room
      // for (Codex 63). The submit fold rejects only a genuinely full date.
      const { bookAttendee } = await import("#test-utils");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const parent = await createDailyTestListing({ name: "Daily base" });
      const child = await createDailyTestListing({
        maxAttendees: 1,
        name: "Daily add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const childRow = (await getListingWithCount(child.id))!;
      const dayA = getBookableStartDates(
        childRow,
        await getActiveHolidays(),
      )[0]!;
      const booked = await bookAttendee(child, { date: dayA });
      expect(booked.success).toBe(true);

      const html = await ticketPageHtml(parent.slug);
      // The parent renders a normal bookable form, not the sold-out message.
      expect(html).toContain(`name="quantity_${parent.id}"`);
      expect(html).toContain(`name="child_qty_${parent.id}_${child.id}"`);
      expect(html).not.toContain("Sorry, this listing is full.");
    });

    test("a standard child sold out cumulatively still makes its parent render sold out", async () => {
      // A STANDARD child uses the date-less cumulative sold-out, which is correct
      // — a cumulatively full standard child leaves the parent with no bookable
      // child, so its page renders sold out (Codex 63, standard branch).
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        maxAttendees: 1,
        name: "Standard add-on",
      });
      await createTestAttendee(child.id, child.slug, "Buyer", "b@x.com");
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain("Sorry, this listing is full.");
      expect(html).not.toContain(`name="quantity_${parent.id}"`);
    });

    test("a parent + child in a 1-spot capped group renders sold out", async () => {
      // Parent and child share a capped group, so the minimum order consumes two
      // group spots. With one spot left, the booking page projects the parent to
      // sold out — matching the card and the submit-time rejection (Fix 4).
      const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
      const parent = await createTestListing({
        groupId: group.id,
        name: "Base unit",
      });
      const child = await createTestListing({
        groupId: group.id,
        name: "Add-on",
      });
      const filler = await createTestListing({
        groupId: group.id,
        name: "Filler",
      });
      await setChildIds(parent.id, [child.id]);
      await createTestAttendee(filler.id, filler.slug, "Buyer", "b@x.com");

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain("Sorry, this listing is full.");
      expect(html).not.toContain(`name="quantity_${parent.id}"`);
    });

    test("a parent + child in a 2-spot capped group renders a bookable form", async () => {
      // With two spots free the combined demand fits, so the parent renders a
      // normal quantity selector and child block (Fix 4).
      const group = await createTestGroup({ maxAttendees: 2, name: "Pool" });
      const parent = await createTestListing({
        groupId: group.id,
        name: "Base unit",
      });
      const child = await createTestListing({
        groupId: group.id,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      expect(html).toContain(`name="quantity_${parent.id}"`);
      // The sole child is offered informationally (auto-selected), so it appears
      // in the child block but posts no `child_qty_*` field.
      expect(html).toContain(`data-sole-child="${child.id}"`);
    });

    test("a shared capped group caps the parent quantity selector by floor(remaining / units)", async () => {
      // Parent and child share a 3-spot capped group; each combined order consumes
      // PARENT_CHILD_GROUP_UNITS (2) spots, so only one combined order fits
      // (floor(3 / 2) = 1). The parent's own max_quantity is high enough (5) that
      // its standalone capacity (clamped to the 3 group spots) would otherwise show
      // a multi-option selector, so the rendered cap proves childOrderCap divides
      // (not the child's own maxPurchasable, and not remaining + units): the
      // quantity selector offers a 1 option but never a 2.
      const { PARENT_CHILD_GROUP_UNITS } = await import("#shared/types.ts");
      expect(PARENT_CHILD_GROUP_UNITS).toBe(2);
      const group = await createTestGroup({ maxAttendees: 3, name: "Pool3" });
      const parent = await createTestListing({
        groupId: group.id,
        maxQuantity: 5,
        name: "Base unit",
      });
      const child = await createTestListing({
        groupId: group.id,
        maxQuantity: 5,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      const quantitySelect = html.slice(
        html.indexOf(`name="quantity_${parent.id}"`),
      );
      const quantityOptionsHtml = quantitySelect.slice(
        0,
        quantitySelect.indexOf("</select>"),
      );
      expect(quantityOptionsHtml).toContain(">1</option>");
      expect(quantityOptionsHtml).not.toContain(">2</option>");
    });

    test("two separate-pool children each cap 1 offer parent quantity up to 2 (Fix 2)", async () => {
      // Under per-unit distribution separate-pool children COMBINE: two children
      // each capped at 1 together serve a parent quantity of 2 (1 + 1). The old
      // per-child MAX wrongly clamped the parent selector to 1; Fix 2 sums them.
      const parent = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Base unit",
      });
      const childA = await createTestListing({
        maxAttendees: 1,
        name: "Add-on A",
      });
      const childB = await createTestListing({
        maxAttendees: 1,
        name: "Add-on B",
      });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const html = await ticketPageHtml(parent.slug);
      const quantitySelect = html.slice(
        html.indexOf(`name="quantity_${parent.id}"`),
      );
      const quantityOptionsHtml = quantitySelect.slice(
        0,
        quantitySelect.indexOf("</select>"),
      );
      // The combined cap (1 + 1) offers a 2 option but never a 3.
      expect(quantityOptionsHtml).toContain(">2</option>");
      expect(quantityOptionsHtml).not.toContain(">3</option>");
    });

    test("a 1+1 booking across two separate-pool children each cap 1 succeeds (Fix 2)", async () => {
      // The fold accepts a parent quantity of 2 split 1 of A + 1 of B, which the
      // selector now offers — proving the combined-cap render matches the fold.
      const parent = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Base unit",
        thankYouUrl: "",
      });
      const childA = await createTestListing({
        maxAttendees: 1,
        name: "Add-on A",
        thankYouUrl: "",
      });
      const childB = await createTestListing({
        maxAttendees: 1,
        name: "Add-on B",
        thankYouUrl: "",
      });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const res = await postBooking(parent.slug, {
        email: "a@b.com",
        name: "Ada",
        [`child_qty_${parent.id}_${childA.id}`]: "1",
        [`child_qty_${parent.id}_${childB.id}`]: "1",
        [`quantity_${parent.id}`]: "2",
      });
      expectReserved(res);
      expect((await getAttendeesRaw(childA.id))[0]?.quantity).toBe(1);
      expect((await getAttendeesRaw(childB.id))[0]?.quantity).toBe(1);
    });

    test("two children sharing one capped group with the parent cap by combined demand, not naive sum (Fix 2)", async () => {
      // Parent + both children share ONE capped group with 5 spots left. Each
      // combined order consumes PARENT_CHILD_GROUP_UNITS (2) spots regardless of
      // how many co-grouped children exist, so the parent ceiling is
      // floor(5 / 2) = 2 — NOT a naive per-child sum (which would over-offer).
      const { PARENT_CHILD_GROUP_UNITS } = await import("#shared/types.ts");
      expect(PARENT_CHILD_GROUP_UNITS).toBe(2);
      const group = await createTestGroup({ maxAttendees: 5, name: "Pool5" });
      const parent = await createTestListing({
        groupId: group.id,
        maxQuantity: 9,
        name: "Base unit",
      });
      const childA = await createTestListing({
        groupId: group.id,
        maxQuantity: 9,
        name: "Add-on A",
      });
      const childB = await createTestListing({
        groupId: group.id,
        maxQuantity: 9,
        name: "Add-on B",
      });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const html = await ticketPageHtml(parent.slug);
      const quantitySelect = html.slice(
        html.indexOf(`name="quantity_${parent.id}"`),
      );
      const quantityOptionsHtml = quantitySelect.slice(
        0,
        quantitySelect.indexOf("</select>"),
      );
      // floor(5 / 2) = 2: offers a 2 option but never a 3 (the cohort is counted
      // once, not summed per co-grouped child).
      expect(quantityOptionsHtml).toContain(">2</option>");
      expect(quantityOptionsHtml).not.toContain(">3</option>");
    });

    test("a parent whose only child is sold out renders sold out on its own page", async () => {
      // On /ticket/<parent> the page must project a no-bookable-child parent to
      // sold out (no quantity selector / Book control), mirroring discovery,
      // instead of a normal form that could only fail at submit (Codex 914).
      const parent = await createTestListing({ name: "Base unit" });
      const child = await createTestListing({
        maxAttendees: 0,
        name: "Add-on",
      });
      await setChildIds(parent.id, [child.id]);

      const html = await ticketPageHtml(parent.slug);
      // The single-listing page renders its unavailable message, not a form.
      expect(html).toContain("Sorry, this listing is full.");
      // No quantity selector / child selector is rendered for the parent.
      expect(html).not.toContain(`name="quantity_${parent.id}"`);
      expect(html).not.toContain(`name="child_qty_${parent.id}_`);
    });

    test("a Square free parent with a paid child renders a present-but-non-required email", async () => {
      // Square requires an email for paid orders, but the page itself is free
      // (only a POSSIBLE child is paid); the email field must be present so a
      // buyer who picks the paid child can fill it, yet non-required so picking
      // the free child / leaving the parent at zero doesn't block submit (Codex
      // 920). Server-side validation enforces it when the folded order is paid.
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.paymentProvider("square");
      try {
        const parent = await createTestListing({
          fields: "",
          name: "Free base",
        });
        const freeChild = await createTestListing({
          name: "Free add-on",
          unitPrice: 0,
        });
        const paidChild = await createTestListing({
          name: "Paid add-on",
          unitPrice: 1500,
        });
        await setChildIds(parent.id, [freeChild.id, paidChild.id]);

        const html = await ticketPageHtml(parent.slug);
        expect(html).toContain('name="email"');
        expect(html).not.toMatch(/name="email"[^>]*\srequired/);
      } finally {
        await settings.update.setPaymentProviderNone();
      }
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
