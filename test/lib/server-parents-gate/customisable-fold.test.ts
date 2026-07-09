// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees.ts";
import {
  bookParent,
  createTestListing,
  describeWithEnv,
  expectFoldedLine,
  expectRejectedBooking,
  expectReserved,
  makeCustomisableDailyParent,
  makeParent,
  parentField,
  postCalculate,
} from "#test-utils";
import { firstBookableDate, stubCheckoutIntent } from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > customisable duration fold",
  { db: true, triggers: true },
  () => {
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

      const date = await firstBookableDate(parent.id);

      const res = await bookParent(`${pageCustom.slug}+${parent.slug}`, {
        date,
        day_count: "2",
        ...parentField(pageCustom, "1"),
        ...parentField(parent, "1"),
      });
      await expectRejectedBooking(res, parent.id);
    });

    test("a customisable child inherits the fixed daily parent's duration", async () => {
      // A fixed 3-day daily parent; its customisable child must be priced and
      // booked for 3 days (the parent's resolved duration), not the default 1.
      const { parent } = await makeCustomisableDailyParent();

      const date = await firstBookableDate(parent.id);

      // The quote owes the child's 3-day price (30.00), not its 1-day price.
      const html = await postCalculate(parent.slug, {
        date,
        ...parentField(parent, "1"),
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
      const { checkout, getCaptured } =
        await stubCheckoutIntent("cs_custom_child");

      const { parent, child } = await makeCustomisableDailyParent();

      const date = await firstBookableDate(parent.id);

      try {
        const res = await bookParent(parent.slug, {
          date,
          ...parentField(parent, "1"),
        });
        expect(res.status).toBe(302);
        // The folded order is customisable, so the chosen span is serialized on the
        // intent (the webhook reprices the child for the inherited 3-day span).
        expect(getCaptured()?.dayCount).toBe(3);
        // The child is priced for the inherited 3 days (£30), never its 1-day £10.
        const childItem = getCaptured()?.items.find(
          (i) => i.listingId === child.id,
        );
        expect(childItem?.unitPrice).toBe(3000);
      } finally {
        checkout.restore();
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
        ...parentField(parent, "1"),
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

      const res = await bookParent(parent.slug, {
        day_count: "2",
        ...parentField(parent, "1"),
      });
      expect(res.status).toBe(302);
      expect((await getAttendeesRaw(parent.id)).length).toBe(1);
      // The child folded as an ordinary (dateless) line of quantity 1.
      await expectFoldedLine(child, 1);
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

      const date = await firstBookableDate(parent.id);

      const res = await bookParent(parent.slug, {
        date,
        day_count: "2",
        ...parentField(parent, "1"),
      });
      expectReserved(res);
      expect((await getAttendeesRaw(child.id)).length).toBe(1);
    });

    test("a fixed daily child whose duration differs from the chosen span is rejected; the matching span folds", async () => {
      // A customisable daily parent offering 1 or 3 days, with a fixed 3-day
      // daily child. A 1-day booking can't fold the 3-day child (its span would
      // not match the parent's), so the parent is sold out; a 3-day booking
      // folds the child fine.
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

      const date = await firstBookableDate(parent.id);

      const rejected = await bookParent(parent.slug, {
        date,
        day_count: "1",
        ...parentField(parent, "1"),
      });
      await expectRejectedBooking(
        rejected,
        parent.id,
        "Daily base has no available options right now.",
      );

      const ok = await bookParent(parent.slug, {
        date,
        day_count: "3",
        ...parentField(parent, "1"),
      });
      expectReserved(ok);
      expect((await getAttendeesRaw(child.id)).length).toBe(1);
    });
  },
);
