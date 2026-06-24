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
  bookingPageHtml,
  createDailyTestListing,
  createTestAttendee,
  createTestGroup,
  createTestHoliday,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectFlash,
  expectReserved,
  makeParent,
  postBooking,
  postCalculate,
} from "#test-utils";

describeWithEnv(
  "server > parents booking fold",
  { db: true, triggers: true },
  () => {
    test("a single bookable child auto-selects and folds into a free booking", async () => {
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5 }],
        parent: { maxQuantity: 5 },
      });

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
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5 }],
        parent: { maxQuantity: 5 },
      });

      // The rendered page emits no quantity field for the sole child.
      const html = await bookingPageHtml(parent.slug);
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
      const { parent } = await makeParent({
        children: [{ maxQuantity: 5, unitPrice: 500 }],
        parent: { maxQuantity: 5, unitPrice: 1000 },
      });

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
      const { parent, child } = await makeParent({
        children: [
          { canPayMore: true, maxPrice: 5000, maxQuantity: 5, unitPrice: 1000 },
        ],
        parent: { maxQuantity: 5 },
      });

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
      const { parent } = await makeParent({
        children: [{}, {}],
        parent: { name: "Base unit" },
      });

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
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [childA, childB] = [children[0]!, children[1]!];

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
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [childA, childB] = [children[0]!, children[1]!];

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
      const { parent, children } = await makeParent({
        children: [{ maxQuantity: 5 }, { maxQuantity: 5 }],
        parent: { maxQuantity: 5 },
      });
      const [childA, childB] = [children[0]!, children[1]!];

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
      const { parent, children } = await makeParent({
        children: [{}, {}],
        parent: { maxQuantity: 5 },
      });
      const [childA, childB] = [children[0]!, children[1]!];

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

    // Child-quantity validation rejections: each builds a 2-child parent named
    // "Base unit", posts a booking whose child quantities are invalid, and
    // asserts a 302 + flash + zero parent rows. Per-row fields cover the cases
    // that need a stranger listing or extra child-row assertions.
    type ParentResult = Awaited<ReturnType<typeof makeParent>>;
    type StrangerListing = Awaited<ReturnType<typeof createTestListing>>;
    const REJECTION_CASES: {
      name: string;
      children: NonNullable<Parameters<typeof makeParent>[0]>["children"];
      parent: { maxQuantity?: number; name: string };
      makeStranger?: boolean;
      // Build the posted quantity_*/child_qty_* fields from the resolved parent
      // id, its children, and an optional stranger listing (for the not-a-child
      // case).
      postFields: (args: {
        parentId: number;
        children: ParentResult["children"];
        stranger: StrangerListing | undefined;
      }) => Record<string, string>;
      flash: string;
      // The not-subtracted case also pins childA/childB to zero rows.
      extraChildIdsZero?: boolean;
    }[] = [
      // Parent quantity 2 but only 1 child unit chosen → "choose 1 more add-on".
      {
        children: [{}, {}],
        flash: "Choose 1 more add-on for Base unit.",
        name: "a child total below the parent quantity is rejected (choose more)",
        parent: { maxQuantity: 5, name: "Base unit" },
        postFields: ({ children, parentId }) => ({
          [`quantity_${parentId}`]: "2",
          [`child_qty_${parentId}_${children[0]!.id}`]: "1",
        }),
      },
      // Parent quantity 1 but 2 child units chosen → too many.
      {
        children: [{ maxQuantity: 5 }, { maxQuantity: 5 }],
        flash: "Too many add-ons chosen for Base unit — remove 1 add-on.",
        name: "a child total above the parent quantity is rejected (too many)",
        parent: { maxQuantity: 5, name: "Base unit" },
        postFields: ({ children, parentId }) => ({
          [`quantity_${parentId}`]: "1",
          [`child_qty_${parentId}_${children[0]!.id}`]: "1",
          [`child_qty_${parentId}_${children[1]!.id}`]: "1",
        }),
      },
      // A garbage `child_qty_*` value parses to 0, so a single-bookable-child
      // parent does NOT auto-select (a value was submitted) and the total falls
      // short of the parent quantity.
      {
        children: [{}, {}],
        flash: "Choose 1 more add-on for Base unit.",
        name: "a non-numeric child quantity is treated as zero (rejected as too few)",
        parent: { name: "Base unit" },
        postFields: ({ children, parentId }) => ({
          [`quantity_${parentId}`]: "1",
          [`child_qty_${parentId}_${children[0]!.id}`]: "abc",
        }),
      },
      // A negative `child_qty_*` value must be clamped to 0 (only non-negative
      // integers are accepted), NOT folded as a negative that silently lowers the
      // running total to the parent quantity. Here childA="-1" and childB="2": if
      // the negative were honoured the total would be 1 and the booking would slip
      // through; clamped to 0 the total is 2, one over the parent quantity of 1.
      {
        children: [{}, {}],
        extraChildIdsZero: true,
        flash: "Too many add-ons chosen for Base unit — remove 1 add-on.",
        name: "a negative child quantity is treated as zero, not subtracted from the total",
        parent: { name: "Base unit" },
        postFields: ({ children, parentId }) => ({
          [`quantity_${parentId}`]: "1",
          [`child_qty_${parentId}_${children[0]!.id}`]: "-1",
          [`child_qty_${parentId}_${children[1]!.id}`]: "2",
        }),
      },
      // Two bookable children, so no auto-select; a quantity submitted for a
      // stranger listing (not a child) must be rejected, never ignored — and the
      // valid total must not be reached by it.
      {
        children: [{}, {}],
        flash: "Please choose an option for Base unit.",
        makeStranger: true,
        name: "a positive quantity for a listing that is not a child of the parent is rejected",
        parent: { name: "Base unit" },
        postFields: ({ parentId, stranger }) => ({
          [`quantity_${parentId}`]: "1",
          [`child_qty_${parentId}_${stranger!.id}`]: "1",
        }),
      },
    ];
    for (const c of REJECTION_CASES) {
      test(c.name, async () => {
        const { parent, children } = await makeParent({
          children: c.children,
          parent: c.parent,
        });
        const stranger = c.makeStranger
          ? await createTestListing({ name: "Stranger" })
          : undefined;

        const res = await postBooking(parent.slug, {
          email: "a@b.com",
          name: "Ada",
          ...c.postFields({ children, parentId: parent.id, stranger }),
        });
        expect(res.status).toBe(302);
        expectFlash(res, c.flash, false);
        expect((await getAttendeesRaw(parent.id)).length).toBe(0);
        if (c.extraChildIdsZero) {
          const [childA, childB] = [children[0]!, children[1]!];
          expect((await getAttendeesRaw(childA.id)).length).toBe(0);
          expect((await getAttendeesRaw(childB.id)).length).toBe(0);
        }
      });
    }

    test("a parent with no bookable child is rejected (sold out)", async () => {
      // A child with no capacity is not bookable, so the parent is sold out.
      const { parent } = await makeParent({
        children: [{ maxAttendees: 0 }],
        parent: { name: "Base unit" },
      });

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
      const { parent: parentA, child: childA } = await makeParent();
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
      const { parent, child } = await makeParent({
        children: [{ canPayMore: true, maxPrice: 5000, unitPrice: 1000 }],
      });

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
      const { parent } = await makeParent({
        children: [
          {
            customisableDays: true,
            dayPrices: { 2: 2000, 3: 3000 },
            durationDays: 3,
          },
        ],
        parent: { daily: true, durationDays: 3 },
      });

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
      const { parent, child } = await makeParent({
        children: [{ canPayMore: true, maxPrice: 5000, unitPrice: 1000 }],
      });

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
      const { parent } = await makeParent({
        children: [
          {
            customisableDays: true,
            dayPrices: { 1: 1000, 3: 3000 },
            durationDays: 3,
            maxPrice: 0,
            unitPrice: 0,
          },
        ],
        parent: { daily: true, durationDays: 3 },
      });

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

      const { parent, child } = await makeParent({
        children: [
          {
            customisableDays: true,
            dayPrices: { 1: 1000, 3: 3000 },
            durationDays: 3,
            maxPrice: 0,
            unitPrice: 0,
          },
        ],
        parent: { daily: true, durationDays: 3 },
      });

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
      const { parent } = await makeParent({
        children: [
          {
            customisableDays: true,
            dayPrices: { 1: 1500, 2: 2500 },
            durationDays: 2,
            maxPrice: 0,
            unitPrice: 0,
          },
        ],
        parent: {
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 1800 },
          durationDays: 2,
        },
      });

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
      const { parent, child } = await makeParent({
        parent: {
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 1800 },
          durationDays: 2,
        },
      });

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
      const { parent } = await makeParent({
        children: [{ maxPrice: 0, unitPrice: 1500 }],
      });

      // Parent is free, child costs 15.00 — the quote must reflect the child.
      const html = await postCalculate(parent.slug, {
        [`quantity_${parent.id}`]: "1",
      });
      expect(html).toContain("£15");
    });

    test("a selected child's question is parsed and saved against its line", async () => {
      const { parent, child } = await makeParent();
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
      const html = await bookingPageHtml(parent.slug);
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
      const { parent, child } = await makeParent();
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
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [childA, childB] = [children[0]!, children[1]!];

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

      const html = await bookingPageHtml(parent.slug);
      // Page question renders required.
      expect(html).toContain(`name="question_${pageQ.id}" required`);
      // Shared child question renders exactly once and non-required.
      const sharedCount =
        html.split(`name="question_${sharedQ.id}"`).length - 1;
      expect(sharedCount).toBe(1);
      expect(html).not.toContain(`name="question_${sharedQ.id}" required`);
    });

    test("a child's all-deactivated choice question is dropped from the page", async () => {
      const { parent, child } = await makeParent();

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

      const html = await bookingPageHtml(parent.slug);
      expect(html).not.toContain(`name="question_${question.id}"`);
    });

    test("a rejected multi-child submission re-fills the chosen child", async () => {
      const { handleRequest } = await import("#routes");
      const { followRedirectWithFlash, submitMultiTicketForm } = await import(
        "#test-utils"
      );
      const { settings } = await import("#shared/db/settings.ts");
      await settings.update.terms("You must accept the rules.");
      const { parent, children } = await makeParent({
        children: [{}, {}],
        parent: { maxQuantity: 5 },
      });
      const [childA, childB] = [children[0]!, children[1]!];

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
      const { parent } = await makeParent({
        parent: { thankYouUrl: "https://example.com/thanks-parent" },
      });

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

      const { parent } = await makeParent({
        children: [{ maxAttendees: 50, unitPrice: 1000 }],
        parent: {
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks-parent",
          unitPrice: 1000,
        },
      });

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
      const { parent, child } = await makeParent({
        parent: { name: "Base unit" },
      });
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
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [dead, live] = [children[0]!, children[1]!];
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

      // The child shares the parent's full (every-day) calendar.
      const { parent, child } = await makeParent({
        children: [{ daily: true }],
        parent: { daily: true },
      });

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

      const { parent, child } = await makeParent({
        children: [{ daily: true, maxAttendees: 1 }],
        parent: { daily: true },
      });

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

    test("a daily child full on one date still renders bookable; the parent qty is not clamped to 0 (Fix 3)", async () => {
      // Render regression for Fix 3: a 1-capacity daily child full on ANY single
      // date reads `isSoldOut` date-lessly, but the render predicate must NOT use
      // that aggregate for a daily child (its per-date capacity is the fold's
      // job). Before the fix the child rendered disabled and `childCappedMax`
      // clamped the parent's quantity to 0 on every date; after it the parent
      // still offers a bookable quantity and the child a per-unit select.
      const { bookAttendee } = await import("#test-utils");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const { parent, child } = await makeParent({
        children: [{ daily: true, maxAttendees: 1 }],
        parent: { daily: true, maxQuantity: 5 },
      });

      // Fill the child's single spot on its first bookable date.
      const childRow = (await getListingWithCount(child.id))!;
      const dayA = getBookableStartDates(
        childRow,
        await getActiveHolidays(),
      )[0]!;
      expect((await bookAttendee(child, { date: dayA })).success).toBe(true);

      const html = await bookingPageHtml(parent.slug);
      // The parent's quantity selector still offers a bookable quantity (the
      // date-less sold-out child did NOT clamp it to 0).
      const select = html.slice(html.indexOf(`name="quantity_${parent.id}"`));
      const options = select.slice(0, select.indexOf("</select>"));
      expect(options).toContain('value="1"');
      // The sole daily child renders informational (auto-selected), not disabled.
      expect(html).toContain(`data-sole-child="${child.id}"`);
      expect(html).not.toMatch(
        new RegExp(
          `<select name="child_qty_${parent.id}_${child.id}"[^>]*\\sdisabled`,
        ),
      );
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

      const { group, parent, child } = await makeParent({
        children: [{ daily: true }],
        group: { maxAttendees: 2, name: "Pool" },
        parent: { daily: true },
      });
      const filler = await createDailyTestListing({
        groupId: group!.id,
        name: "Daily filler",
        thankYouUrl: "",
      });

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

    test("a standard child folded under a daily parent is stored date-less", async () => {
      // A standard (date-less) child has cumulative, date-independent capacity.
      // When folded under a DAILY parent it must NOT inherit the parent's date —
      // writing the date would switch its capacity guard to the date-overlap path
      // and let the same add-on be oversold across different parent dates. The
      // fold carries it as an ordinary line and `bookingDateFields` nulls its date
      // by listing type, so the stored child row is date-less while the parent's
      // row keeps the booked date (Codex "Keep dateless children date-less").
      const { parent, child } = await makeParent({ parent: { daily: true } });

      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");
      const parentRow = (await getListingWithCount(parent.id))!;
      const dayB = getBookableStartDates(
        parentRow,
        await getActiveHolidays(),
      )[0]!;

      const res = await postBooking(parent.slug, {
        date: dayB,
        email: "a@b.com",
        name: "Ada",
        [`quantity_${parent.id}`]: "1",
      });
      expectReserved(res);
      // Parent row keeps the booked date; the standard child row is date-less.
      expect((await getAttendeesRaw(parent.id))[0]?.date).toBe(dayB);
      expect((await getAttendeesRaw(child.id))[0]?.date).toBe(null);
    });

    test("a daily parent + daily child are still rejected on a genuinely full date", async () => {
      // The date-aware checkBatchAvailability must still reject the parent+child
      // on a date whose shared group is full, so deferring does not oversell.
      const { bookAttendee } = await import("#test-utils");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const { group, parent, child } = await makeParent({
        children: [{ daily: true }],
        group: { maxAttendees: 2, name: "Pool" },
        parent: { daily: true },
      });
      const filler = await createDailyTestListing({
        groupId: group!.id,
        name: "Daily filler",
        thankYouUrl: "",
      });

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

    test("a daily child required by two parents carries each parent's own data-child-dates (Fix 4)", async () => {
      // The SAME daily child is required by two daily parents on different
      // calendars (parent A bookable only Mondays, parent B only Tuesdays). Each
      // parent's block must carry the child's serveable dates FOR THAT PARENT —
      // keyed by the (parent, child) pair. Before Fix 4 the map was keyed by child
      // id alone, so the second parent overwrote the first and both blocks showed
      // the same (later parent's) dates.
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      // Each parent gets a SECOND child so the shared child renders as a
      // selectable `child_qty_*` option (carrying data-child-dates) rather than
      // the informational sole-child path (which emits no compat attributes).
      const parentA = await createDailyTestListing({
        bookableDays: ["Monday"],
        name: "Monday base",
      });
      const parentB = await createDailyTestListing({
        bookableDays: ["Tuesday"],
        name: "Tuesday base",
      });
      const shared = await createDailyTestListing({ name: "Shared add-on" });
      const extraA = await createDailyTestListing({ name: "Extra A" });
      const extraB = await createDailyTestListing({ name: "Extra B" });
      await setChildIds(parentA.id, [shared.id, extraA.id]);
      await setChildIds(parentB.id, [shared.id, extraB.id]);

      const holidays = await getActiveHolidays();
      const mondayDate = getBookableStartDates(
        (await getListingWithCount(parentA.id))!,
        holidays,
      )[0]!;
      const tuesdayDate = getBookableStartDates(
        (await getListingWithCount(parentB.id))!,
        holidays,
      )[0]!;
      expect(mondayDate).not.toBe(tuesdayDate);

      const html = await bookingPageHtml(`${parentA.slug}+${parentB.slug}`);

      // Isolate each parent's control for the shared child and read its dates.
      const datesAttr = (parentId: number): string => {
        const start = html.indexOf(`name="child_qty_${parentId}_${shared.id}"`);
        expect(start).toBeGreaterThanOrEqual(0);
        const select = html.slice(start, html.indexOf(">", start));
        const match = select.match(/data-child-dates="([^"]*)"/);
        return match?.[1] ?? "";
      };

      // Parent A's block lists the shared child as serveable on its Monday only;
      // parent B's on its Tuesday only — each parent's own calendar, not shared.
      expect(datesAttr(parentA.id)).toContain(mondayDate);
      expect(datesAttr(parentA.id)).not.toContain(tuesdayDate);
      expect(datesAttr(parentB.id)).toContain(tuesdayDate);
      expect(datesAttr(parentB.id)).not.toContain(mondayDate);
    });

    // Price-label rendering: build a customisable parent+child, render the
    // booking page, and assert the child's option label contains / omits a
    // particular price string. Each row supplies its makeParent spec plus the
    // contains/notContains assertions.
    const PRICE_LABEL_CASES: {
      name: string;
      spec: Parameters<typeof makeParent>[0];
      contains: string[];
      notContains: string[];
    }[] = [
      // A fixed-duration (standard) parent inherits duration 1; the customisable
      // child's label must show its 1-day price (10.00), never its unit_price
      // (0, which would advertise "free" while checkout charges the day price).
      // The sole child renders informationally; its label carries the day price,
      // not "£0".
      {
        contains: ["Customisable add-on", "(£10"],
        name: "a customisable child's option label shows the inherited day price, not its unit_price",
        notContains: ["(£0"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1000 },
              durationDays: 1,
              maxPrice: 0,
              name: "Customisable add-on",
              unitPrice: 0,
            },
          ],
        },
      },
      // A customisable parent has no single render-time duration, so its
      // customisable child's label shows "from <min day price>" (15.00).
      {
        contains: ["Customisable add-on", "(from £15"],
        name: "a customisable child under a customisable parent shows a 'from' price",
        notContains: [],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1500, 2: 2500 },
              durationDays: 2,
              maxPrice: 0,
              name: "Customisable add-on",
              unitPrice: 0,
            },
          ],
          parent: {
            customisableDays: true,
            dayPrices: { 1: 1000, 2: 1800 },
            durationDays: 2,
          },
        },
      },
      // The parent can only offer a 3-day span; the child is priced 1 day £10,
      // 3 days £25. The label must show the price for a span the parent can
      // actually book (£25), not the child's own cheapest span (£10) the parent
      // can never select (Codex 398).
      {
        contains: ["(from £25"],
        name: "a 'from' price uses the parent∩child spans, not the child's lowest",
        notContains: ["(from £10"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1000, 3: 2500 },
              durationDays: 3,
              maxPrice: 0,
              unitPrice: 0,
            },
          ],
          parent: {
            customisableDays: true,
            dayPrices: { 3: 5000 },
            durationDays: 3,
          },
        },
      },
      // The parent offers only a 3-day span; the child is priced only for 1 day.
      // With no overlapping span the label omits the price entirely (the edge
      // isn't bookable anyway).
      {
        contains: ["One-day add-on"],
        name: "a 'from' price is omitted when parent and child spans don't overlap",
        notContains: ["One-day add-on (from", "One-day add-on (£"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1000 },
              durationDays: 1,
              maxPrice: 0,
              name: "One-day add-on",
              unitPrice: 0,
            },
          ],
          parent: {
            customisableDays: true,
            dayPrices: { 3: 5000 },
            durationDays: 3,
          },
        },
      },
      // The fixed daily parent inherits duration 3, but the child has no 3-day
      // price — the label omits the price rather than advertising a wrong one.
      // The option appears with no price suffix (no "(£" after the name).
      {
        contains: ["Two-day add-on"],
        name: "a customisable child unpriced for a fixed parent's duration shows no price",
        notContains: ["Two-day add-on (£", "Two-day add-on (from"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 2: 2000 },
              durationDays: 2,
              maxPrice: 0,
              name: "Two-day add-on",
              unitPrice: 0,
            },
          ],
          parent: { daily: true, durationDays: 3 },
        },
      },
    ];
    for (const c of PRICE_LABEL_CASES) {
      test(c.name, async () => {
        const { parent } = await makeParent(c.spec);
        const html = await bookingPageHtml(parent.slug);
        for (const needle of c.contains) {
          expect(html).toContain(needle);
        }
        for (const needle of c.notContains) {
          expect(html).not.toContain(needle);
        }
      });
    }

    test("a daily child under a dateless (standard) parent is rejected", async () => {
      // The standard parent produces no date, so a daily child can never be
      // dated — the parent is treated as sold out (defensive: admin blocks this
      // edge, but the gate must not fold a child onto a null date).
      const { parent } = await makeParent({
        children: [{ daily: true }],
        parent: { name: "Standard base" },
      });

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
      const { parent, child } = await makeParent({
        children: [
          {
            customisableDays: true,
            daily: true,
            dayPrices: { 1: 1500, 2: 2500 },
            durationDays: 2,
            maxPrice: 0,
            unitPrice: 0,
          },
        ],
        parent: {
          customisableDays: true,
          daily: true,
          dayPrices: { 1: 1000, 2: 1800 },
          durationDays: 2,
        },
      });

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
      const { parent, child } = await makeParent({
        children: [{ daily: true, durationDays: 3 }],
        parent: {
          customisableDays: true,
          daily: true,
          dayPrices: { 1: 1000, 3: 3000 },
          durationDays: 3,
          name: "Daily base",
        },
      });

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
      // A bookable but NON-pay-more sibling must get no price input at all.
      const { parent, children } = await makeParent({
        children: [
          { canPayMore: true, maxPrice: 5000, unitPrice: 1000 },
          { canPayMore: true, maxPrice: 5000, unitPrice: 1000 },
          { unitPrice: 1000 },
        ],
      });
      const [childA, childB, fixedChild] = [
        children[0]!,
        children[1]!,
        children[2]!,
      ];

      const html = await bookingPageHtml(parent.slug);
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
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const [liveChild, deadChild] = [children[0]!, children[1]!];
      await deactivateTestListing(deadChild.id);

      const html = await bookingPageHtml(parent.slug);
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
      const { parent, children } = await makeParent({
        children: [{ maxQuantity: 2 }, { maxQuantity: 2 }],
        parent: { maxQuantity: 2 },
      });
      const [childA, childB] = [children[0]!, children[1]!];

      const html = await bookingPageHtml(parent.slug);
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
      const { parent, child } = await makeParent({
        children: [{ canPayMore: true, maxPrice: 5000, unitPrice: 1000 }],
      });

      const html = await bookingPageHtml(parent.slug);
      // No `child_qty_*` is posted for the sole child (the fold auto-fills it).
      expect(html).not.toContain(`name="child_qty_${parent.id}_${child.id}"`);
      // The pay-more price input is still rendered.
      expect(html).toContain(`name="child_price_${parent.id}_${child.id}"`);
    });

    test("a sole bookable child renders informational with no submitted quantity field (Fix 1)", async () => {
      // A sole bookable child must NOT post a fixed quantity (it would over-submit
      // when the parent qty is below the child's cap and the fold would reject it
      // as 'too many'). It renders informational; the fold auto-fills Q.
      const { parent, child } = await makeParent({
        children: [{ maxQuantity: 5, name: "Add-on" }],
        parent: { maxQuantity: 5 },
      });

      const html = await bookingPageHtml(parent.slug);
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

      const html = await bookingPageHtml(parent.slug);
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

      const { parent } = await makeParent({ parent: { daily: true } });

      const parentRow = (await getListingWithCount(parent.id))!;
      const parentDates = getBookableStartDates(
        parentRow,
        await getActiveHolidays(),
      );

      const html = await bookingPageHtml(parent.slug);
      for (const d of parentDates) {
        expect(html).toContain(`<option value="${d}"`);
      }
    });

    // Day-count-union rendering on a SINGLE-listing customisable parent page:
    // build the parent+child, render, and assert which "<n> day(s)" labelled
    // options the selector offers. (The labelled "<n> day(s)" string is the
    // day-count option — the bare `<option value="1">` of the quantity selector
    // is a different control, so the assertions key on the labelled option.)
    const DAY_COUNT_UNION_CASES: {
      name: string;
      spec: Parameters<typeof makeParent>[0];
      contains: string[];
      notContains: string[];
    }[] = [
      // The parent prices {1,2} days; its only child prices only 2 days. The
      // rendered day-count selector must offer only the 2-day option — the
      // 1-day option the submit fold would reject is gone (Codex 1030).
      {
        contains: [">2 days"],
        name: "a customisable parent offers only day counts its child can serve",
        notContains: [">1 day"],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 2: 2500 },
              durationDays: 2,
              maxPrice: 0,
              unitPrice: 0,
            },
          ],
          parent: {
            customisableDays: true,
            dayPrices: { 1: 1000, 2: 1800 },
            durationDays: 2,
          },
        },
      },
      // The child prices both 1 and 2 days, so the parent keeps both options
      // (the union covers every parent span) — Codex 1030.
      {
        contains: [">1 day", ">2 days"],
        name: "a customisable parent keeps day counts a child supports both of",
        notContains: [],
        spec: {
          children: [
            {
              customisableDays: true,
              dayPrices: { 1: 1500, 2: 2500 },
              durationDays: 2,
              maxPrice: 0,
              unitPrice: 0,
            },
          ],
          parent: {
            customisableDays: true,
            dayPrices: { 1: 1000, 2: 1800 },
            durationDays: 2,
          },
        },
      },
      // The parent offers {1,2,3} days; its only required child is a FIXED 2-day
      // daily listing, whose supported span is exactly its duration_days (2). The
      // day-count selector must therefore offer only the 2-day option — a daily
      // child must NOT be treated as imposing "any" span (which would keep all of
      // {1,2,3}), it constrains to its own fixed duration (childSupportedSpans).
      // Only the child's own 2-day span is offered; the 1- and 3-day options the
      // child cannot serve are dropped from the union.
      {
        contains: [">2 days"],
        name: "a customisable parent's day counts are constrained to a fixed daily child's own span",
        notContains: [">1 day", ">3 days"],
        spec: {
          children: [{ daily: true, durationDays: 2 }],
          parent: {
            customisableDays: true,
            dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
            durationDays: 3,
          },
        },
      },
    ];
    for (const c of DAY_COUNT_UNION_CASES) {
      test(c.name, async () => {
        const { parent } = await makeParent(c.spec);
        const html = await bookingPageHtml(parent.slug);
        for (const needle of c.contains) {
          expect(html).toContain(needle);
        }
        for (const needle of c.notContains) {
          expect(html).not.toContain(needle);
        }
      });
    }

    test("a multi-listing page does NOT constrain the shared day counts by one parent's child", async () => {
      // The day-count union constraint is SINGLE-listing only: on a multi-listing
      // page the day-count selector is shared, so a parent's restrictive child must
      // not remove a span a sibling page listing still needs (the per-parent
      // constraint is deferred to JS + the submit fold). Page = a customisable
      // parent (child supports only 2 days) PLUS a plain customisable listing
      // offering {1,2}: the shared selector must keep BOTH the 1- and 2-day options.
      const { parent } = await makeParent({
        children: [
          {
            customisableDays: true,
            dayPrices: { 2: 2500 },
            durationDays: 2,
            maxPrice: 0,
            unitPrice: 0,
          },
        ],
        parent: {
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 1800 },
          durationDays: 2,
        },
      });
      const sibling = await createTestListing({
        customisableDays: true,
        dayPrices: { 1: 1200, 2: 2000 },
        durationDays: 2,
        name: "Sibling listing",
      });

      const html = await bookingPageHtml(`${parent.slug}+${sibling.slug}`);
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

      const html = await bookingPageHtml(parent.slug);
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

      const html = await bookingPageHtml(parent.slug);
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

      // A FIXED 3-day daily child bookable only on Mon/Tue/Wed: only a Monday
      // start fits a whole 3-day Mon-Tue-Wed span.
      const { parent } = await makeParent({
        children: [
          {
            bookableDays: ["Monday", "Tuesday", "Wednesday"],
            daily: true,
            durationDays: 3,
          },
        ],
        parent: {
          customisableDays: true,
          daily: true,
          dayPrices: { 1: 1000, 2: 1800, 3: 2500 },
          durationDays: 3,
        },
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

      const html = await bookingPageHtml(parent.slug);
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
      const { parent, children } = await makeParent({
        children: [
          { maxPrice: 0, unitPrice: 0 },
          {
            customisableDays: true,
            dayPrices: { 2: 2500 },
            durationDays: 2,
            maxPrice: 0,
            unitPrice: 0,
          },
        ],
        parent: {
          customisableDays: true,
          dayPrices: { 1: 1000, 2: 1800 },
          durationDays: 2,
        },
      });
      const inactiveOneDay = children[0]!;
      await deactivateTestListing(inactiveOneDay.id);

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain(">2 days");
      expect(html).not.toContain(">1 day");
    });

    test("a daily child full on one date does not make its parent render sold out", async () => {
      // A 1-capacity daily child fully booked on one date reads date-less
      // isSoldOut=true, but the parent page must still render a bookable form —
      // the daily child is potentially bookable on the dates it still has room
      // for (Codex 63). The submit fold rejects only a genuinely full date.
      // Fix 3 also keeps the daily child a BOOKABLE option (its date-less
      // sold-out aggregate is exempt), so it auto-selects as the sole child
      // instead of rendering a disabled control. (See the Fix-3 render test above
      // for the parent-quantity-not-clamped-to-0 outcome.)
      const { bookAttendee } = await import("#test-utils");
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const { parent, child } = await makeParent({
        children: [{ daily: true, maxAttendees: 1 }],
        parent: { daily: true },
      });

      const childRow = (await getListingWithCount(child.id))!;
      const dayA = getBookableStartDates(
        childRow,
        await getActiveHolidays(),
      )[0]!;
      const booked = await bookAttendee(child, { date: dayA });
      expect(booked.success).toBe(true);

      const html = await bookingPageHtml(parent.slug);
      // The parent renders a normal bookable form, not the sold-out message.
      expect(html).toContain(`name="quantity_${parent.id}"`);
      // The daily child is the sole bookable option (Fix 3), rendered
      // informational — never as a disabled control.
      expect(html).toContain(`data-sole-child="${child.id}"`);
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

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain("Sorry, this listing is full.");
      expect(html).not.toContain(`name="quantity_${parent.id}"`);
    });

    test("a parent + child in a 1-spot capped group renders sold out", async () => {
      // Parent and child share a capped group, so the minimum order consumes two
      // group spots. With one spot left, the booking page projects the parent to
      // sold out — matching the card and the submit-time rejection (Fix 4).
      const { group, parent } = await makeParent({
        group: { maxAttendees: 2, name: "Pool" },
      });
      const filler = await createTestListing({
        groupId: group!.id,
        name: "Filler",
      });
      await createTestAttendee(filler.id, filler.slug, "Buyer", "b@x.com");

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain("Sorry, this listing is full.");
      expect(html).not.toContain(`name="quantity_${parent.id}"`);
    });

    test("a parent + child in a 2-spot capped group renders a bookable form", async () => {
      // With two spots free the combined demand fits, so the parent renders a
      // normal quantity selector and child block (Fix 4).
      const { parent, child } = await makeParent({
        group: { maxAttendees: 2, name: "Pool" },
      });

      const html = await bookingPageHtml(parent.slug);
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
      const { parent } = await makeParent({
        children: [{ maxQuantity: 5 }],
        group: { maxAttendees: 3, name: "Pool3" },
        parent: { maxQuantity: 5 },
      });

      const html = await bookingPageHtml(parent.slug);
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

    test("a shared-group child's own qty select is capped by floor(remaining / units)", async () => {
      // The per-CHILD quantity select must be clamped by the child's own combined
      // order cap, not only by the parent total. Here a separate-pool sibling
      // (cap 5) lifts the parent total well above 1, so the parent ceiling no
      // longer masks the shared child's cap: the shared child's select must still
      // offer floor(3 / 2) = 1 — proving childOrderCap DIVIDES the shared
      // remaining (not remaining + units, which would offer 5).
      const { PARENT_CHILD_GROUP_UNITS } = await import("#shared/types.ts");
      expect(PARENT_CHILD_GROUP_UNITS).toBe(2);
      const group = await createTestGroup({ maxAttendees: 3, name: "Pool3" });
      const parent = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Base unit",
      });
      // A separate-pool child with plenty of capacity, so the parent total is high.
      const sibling = await createTestListing({
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Add-on sibling",
      });
      // A child sharing the parent's 3-spot capped pool: floor(3 / 2) = 1.
      const sharedChild = await createTestListing({
        groupId: group.id,
        maxAttendees: 100,
        maxQuantity: 5,
        name: "Add-on shared",
      });
      await setChildIds(parent.id, [sibling.id, sharedChild.id]);

      const html = await bookingPageHtml(parent.slug);
      const sharedSelect = html.slice(
        html.indexOf(`name="child_qty_${parent.id}_${sharedChild.id}"`),
      );
      const sharedOptions = sharedSelect.slice(
        0,
        sharedSelect.indexOf("</select>"),
      );
      expect(sharedOptions).toContain(">1</option>");
      expect(sharedOptions).not.toContain(">2</option>");
    });

    test("two separate-pool children each cap 1 offer parent quantity up to 2 (Fix 2)", async () => {
      // Under per-unit distribution separate-pool children COMBINE: two children
      // each capped at 1 together serve a parent quantity of 2 (1 + 1). The old
      // per-child MAX wrongly clamped the parent selector to 1; Fix 2 sums them.
      const { parent } = await makeParent({
        children: [{ maxAttendees: 1 }, { maxAttendees: 1 }],
        parent: { maxAttendees: 100, maxQuantity: 5 },
      });

      const html = await bookingPageHtml(parent.slug);
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
      const { parent, children } = await makeParent({
        children: [{ maxAttendees: 1 }, { maxAttendees: 1 }],
        parent: { maxAttendees: 100, maxQuantity: 5 },
      });
      const [childA, childB] = [children[0]!, children[1]!];

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
      const { parent } = await makeParent({
        children: [{ maxQuantity: 9 }, { maxQuantity: 9 }],
        group: { maxAttendees: 5, name: "Pool5" },
        parent: { maxQuantity: 9 },
      });

      const html = await bookingPageHtml(parent.slug);
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
      const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });

      const html = await bookingPageHtml(parent.slug);
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
        const { parent } = await makeParent({
          children: [{ unitPrice: 0 }, { unitPrice: 1500 }],
          parent: { fields: "" },
        });

        const html = await bookingPageHtml(parent.slug);
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
      const { parent } = await makeParent({
        children: [{ fields: "email,phone" }],
        parent: { fields: "email" },
      });

      const html = await bookingPageHtml(parent.slug);
      expect(html).toContain('name="phone"');
      // The child-only field is present but not HTML-required.
      expect(html).not.toMatch(/name="phone"[^>]*\srequired/);
    });

    test("a sole daily child carries its compatibility data on the informational marker (Fix 1)", async () => {
      // On a parent page the sole child renders informationally (no quantity
      // control). Before Fix 1 it carried NO `data-child-dates`, so on a group /
      // multi-listing page the client compat script couldn't tell the auto-selected
      // sole child can't serve the chosen date — the buyer saw "Includes …" and hit
      // the submit-side rejection. The marker must now carry the same compat data a
      // selectable child option does, keyed to the fixed parent span (1).
      const { getBookableStartDates } = await import("#shared/dates.ts");
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const { parent, child } = await makeParent({
        children: [{ daily: true }],
        parent: { daily: true },
      });

      const childRow = (await getListingWithCount(child.id))!;
      const childDates = getBookableStartDates(
        childRow,
        await getActiveHolidays(),
      ).join(",");

      const html = await bookingPageHtml(parent.slug);
      // The sole-child marker carries the span-keyed serveable dates (Fix 1/4).
      const marker = html.slice(html.indexOf(`data-sole-child="${child.id}"`));
      const block = marker.slice(0, marker.indexOf(">"));
      expect(block).toContain(`data-child-dates="1:${childDates}"`);
      expect(childDates.length).toBeGreaterThan(0);
    });

    test("a customisable parent's daily child advertises a date set per span (Fix 4)", async () => {
      // A customisable daily parent offers spans {1,2}. A daily child can start a
      // given day for a 1-day span, but a holiday on the next day makes the 2-day
      // span starting that day invalid. The child's `data-child-dates` must carry
      // the date PER span — that start appears in the 1-day set but NOT the 2-day
      // set — so the client picks the right set for the chosen day_count rather
      // than offering a Monday the 2-day fold rejects. A second daily child keeps
      // the per-child selectors rendered (no sole-child auto-select).
      const { getBookableStartDates, isBookingRangeValid } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      const { parent, children } = await makeParent({
        children: [{ daily: true }, { daily: true }],
        parent: {
          customisableDays: true,
          daily: true,
          dayPrices: { 1: 1000, 2: 1800 },
          durationDays: 2,
        },
      });
      const childA = children[0]!;

      // Put a holiday on the day AFTER child A's first serveable start, so a 2-day
      // span from that start is invalid while a 1-day span is fine.
      const childARow = (await getListingWithCount(childA.id))!;
      const baseHolidays = await getActiveHolidays();
      const starts = getBookableStartDates(childARow, baseHolidays);
      const splitStart = starts[0]!;
      const nextDay = new Date(`${splitStart}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      const holidayDate = nextDay.toISOString().slice(0, 10);
      await createTestHoliday({ endDate: holidayDate, startDate: holidayDate });

      const holidays = await getActiveHolidays();
      const oneDay = getBookableStartDates(childARow, holidays).filter((d) =>
        isBookingRangeValid(childARow, d, 1, holidays),
      );
      const twoDay = getBookableStartDates(childARow, holidays).filter((d) =>
        isBookingRangeValid(childARow, d, 2, holidays),
      );
      // The setup must actually split the two spans (else the test proves nothing).
      expect(oneDay).toContain(splitStart);
      expect(twoDay).not.toContain(splitStart);

      const html = await bookingPageHtml(parent.slug);
      const control = html.slice(
        html.indexOf(`name="child_qty_${parent.id}_${childA.id}"`),
      );
      const attrs = control.slice(0, control.indexOf(">"));
      const dates = attrs.match(/data-child-dates="([^"]*)"/)?.[1] ?? "";
      expect(dates).toBe(`1:${oneDay.join(",")}|2:${twoDay.join(",")}`);
    });

    test("a daily parent's daily child carries its serveable dates as data-child-dates (Codex 430)", async () => {
      const { DAY_NAMES, getBookableStartDates } = await import(
        "#shared/dates.ts"
      );
      const { getActiveHolidays } = await import("#shared/db/holidays.ts");
      const { getListingWithCount } = await import("#shared/db/listings.ts");

      // Two daily children so the per-child selectors render (no sole-child
      // auto-select): child A serves every day, child B only one weekday — so the
      // client compatibility script can tell them apart by their date sets.
      const parent = await createDailyTestListing({ name: "Daily base" });
      const childA = await createDailyTestListing({ name: "Daily add-on A" });
      const parentRow = (await getListingWithCount(parent.id))!;
      const holidays = await getActiveHolidays();
      const parentDate = getBookableStartDates(parentRow, holidays)[0]!;
      const parentDay =
        DAY_NAMES[new Date(`${parentDate}T00:00:00Z`).getUTCDay()]!;
      const childB = await createDailyTestListing({
        bookableDays: [parentDay],
        name: "Daily add-on B",
      });
      await setChildIds(parent.id, [childA.id, childB.id]);

      const childBRow = (await getListingWithCount(childB.id))!;
      // Mark an active holiday on one of child B's serveable starts. The server's
      // child-date set must be HOLIDAY-AWARE: it computes the dates with the
      // active holidays, so this date is excluded from `data-child-dates`. (If the
      // render path dropped the holidays it would re-appear — this pins the fetch.)
      const childBStarts = getBookableStartDates(childBRow, holidays);
      const holidayDate = childBStarts[1]!;
      await createTestHoliday({ endDate: holidayDate, startDate: holidayDate });

      const refreshedHolidays = await getActiveHolidays();
      const childBDates = getBookableStartDates(
        childBRow,
        refreshedHolidays,
      ).join(",");

      const html = await bookingPageHtml(parent.slug);
      // Child B's control advertises exactly its own (single-weekday) serveable
      // dates — the holiday-aware set the server computed, not the parent's. The
      // fixed daily parent's one inherited span (1) keys the span-aware encoding
      // `span:dates` (Fix 4).
      expect(html).toContain(
        `name="child_qty_${parent.id}_${childB.id}" data-child-qty="${childB.id}" data-child-dates="1:${childBDates}"`,
      );
      expect(childBDates.length).toBeGreaterThan(0);
      // The holiday start must have been removed from the advertised set.
      expect(childBDates).not.toContain(holidayDate);
      expect(html).not.toContain(
        `data-child-dates="1:${childBStarts.join(",")}"`,
      );
    });

    test("a customisable child carries its supported spans as data-child-spans (Codex 430)", async () => {
      // Two children so the per-child selectors render: a customisable child
      // (priced 1 & 3 days) advertises its supported spans; a plain standard
      // child carries no span attribute (always compatible).
      const { parent, children } = await makeParent({
        children: [
          {
            customisableDays: true,
            dayPrices: { 1: 1000, 3: 3000 },
            durationDays: 3,
            maxPrice: 0,
            unitPrice: 0,
          },
          {},
        ],
        parent: {
          customisableDays: true,
          dayPrices: { 1: 1000, 3: 3000 },
          durationDays: 3,
        },
      });
      const [childA, childB] = [children[0]!, children[1]!];

      const html = await bookingPageHtml(parent.slug);
      // The customisable child advertises the spans it can serve.
      expect(html).toContain(
        `name="child_qty_${parent.id}_${childA.id}" data-child-qty="${childA.id}" data-child-spans="1,3"`,
      );
      // The standard child imposes no span constraint, so it emits neither attr.
      const standardControl = html.slice(
        html.indexOf(`name="child_qty_${parent.id}_${childB.id}"`),
      );
      expect(standardControl).not.toContain("data-child-spans");
      expect(standardControl.slice(0, 120)).not.toContain("data-child-dates");
    });
  },
);
