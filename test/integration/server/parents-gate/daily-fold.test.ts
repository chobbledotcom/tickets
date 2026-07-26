// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import {
  childExcludingParentDay,
  firstBookableDate,
  makeDailyChildFilledOnDayA,
  makeDailyGroupWithFiller,
} from "#test/test-utils/parents-gate/helpers.ts";
import { expectFlash } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  bookableStartDates,
  createDailyTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  bookParent,
  expectNoBooking,
  expectRejectedBooking,
  expectReserved,
  makeParent,
  parentField,
} from "#test-utils/parents.ts";

// jscpd:ignore-end

describeWithEnv(
  "server > parents gate > daily child fold",
  { db: true, triggers: true },
  () => {
    test("a daily child whose calendar excludes the submitted date is rejected", async () => {
      const parent = await createDailyTestListing({ name: "Daily base" });
      const { parentDate } = await childExcludingParentDay(parent);

      const res = await bookParent(parent.slug, {
        date: parentDate,
        ...parentField(parent, "1"),
      });
      await expectRejectedBooking(res, parent.id, "Please select a valid date");
    });

    test("the fold rejects a daily child's excluded date on a multi-listing page", async () => {
      // On a multi-listing page the per-parent date-union constraint is NOT
      // applied (it would wrongly strip dates a sibling page listing needs), so
      // the child-excluded date IS offered and reaches the submit fold, which
      // rejects it because the parent then has no bookable child for that date.
      const parent = await createDailyTestListing({ name: "Daily base" });
      const plain = await createDailyTestListing({ name: "Daily plain" });
      const { parentDate } = await childExcludingParentDay(parent);

      const res = await bookParent(`${parent.slug}+${plain.slug}`, {
        date: parentDate,
        ...parentField(parent, "1"),
        ...parentField(plain, "0"),
      });
      await expectRejectedBooking(
        res,
        parent.id,
        "Daily base has no available options right now.",
      );
    });

    test("a daily child that allows the submitted date folds fine", async () => {
      const { parent, child } = await makeParent({
        children: [{ daily: true }],
        parent: { daily: true },
      });

      const date = await firstBookableDate(parent.id);

      const res = await bookParent(parent.slug, {
        date,
        ...parentField(parent, "1"),
      });
      expectReserved(res);
      expect((await getAttendeesRaw(child.id)).length).toBe(1);
    });

    test("a daily child full on day A still folds for a parent booking on day B", async () => {
      // A 1-capacity daily child is fully booked on day A. Its date-less
      // `isSoldOut` aggregate reads true, but a parent booking on day B (where
      // the child still has capacity) must fold the child fine — the date-less
      // flag must not block a daily child.
      const { parent, child } = await makeDailyChildFilledOnDayA();

      // dayB is the child's second bookable date (day A is now full).
      const dayB = (await bookableStartDates(child.id))[1]!;

      const okRes = await bookParent(parent.slug, {
        date: dayB,
        ...parentField(parent, "1"),
      });
      expectReserved(okRes);
      const childOnB = (await getAttendeesRaw(child.id)).filter(
        (r) => r.date === dayB,
      );
      expect(childOnB.length).toBe(1);
      // The day-B booking reserved the parent on day B (not the full day A).
      const parentOnB = (await getAttendeesRaw(parent.id)).filter(
        (r) => r.date === dayB,
      );
      expect(parentOnB.length).toBe(1);
    });

    test("a daily child full on day A rejects a parent booking on day A", async () => {
      // The date-less `isSoldOut` flag must not block a daily child, but the
      // folded per-date availability check must still reject a booking on the
      // genuinely full day A.
      const { parent, dayA } = await makeDailyChildFilledOnDayA();

      const fullRes = await bookParent(parent.slug, {
        date: dayA,
        email: "b@c.com",
        name: "Bea",
        ...parentField(parent, "1"),
      });
      expect(fullRes.status).toBe(302);
      expectFlash(fullRes, undefined, false);
      // The rejected day-A attempt created no parent booking.
      expect((await getAttendeesRaw(parent.id)).length).toBe(0);
    });

    // Don't apply the date-less GROUP cap to a daily parent's children. A
    // daily parent's group is type-homogeneous (group members share listing_type),
    // so any co-grouped child is itself daily — and a daily listing is excluded
    // from the date-less group aggregate (its cap is per-date), so it is never
    // pre-marked sold out by another date's bookings. Its per-date group capacity
    // is the date-aware checkBatchAvailability's job at submit. (A *standard*
    // child can't share a daily parent's group at all — the homogeneity rule
    // blocks it — so that date-less-clamp state is
    // unreachable; these tests lock in the correct date-A/date-B behavior.)
    test("a daily parent + daily child in a group full on one date still book on a free date", async () => {
      const { parent, child, dayB } = await makeDailyGroupWithFiller();

      // A parent booking on date B folds the daily child and reserves — date A's
      // cumulative bookings do not clamp the child date-lessly.
      const okRes = await bookParent(parent.slug, {
        date: dayB,
        ...parentField(parent, "1"),
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
      // row keeps the booked date.
      const { parent, child } = await makeParent({ parent: { daily: true } });

      const dayB = await firstBookableDate(parent.id);

      const res = await bookParent(parent.slug, {
        date: dayB,
        ...parentField(parent, "1"),
      });
      expectReserved(res);
      // Parent row keeps the booked date; the standard child row is date-less.
      expect((await getAttendeesRaw(parent.id))[0]?.date).toBe(dayB);
      expect((await getAttendeesRaw(child.id))[0]?.date).toBe(null);
    });

    test("a daily parent + daily child are still rejected on a genuinely full date", async () => {
      // The date-aware checkBatchAvailability must still reject the parent+child
      // on a date whose shared group is full, so deferring does not oversell.
      const { parent, child, dayA } = await makeDailyGroupWithFiller();

      const fullRes = await bookParent(parent.slug, {
        date: dayA,
        email: "b@c.com",
        name: "Bea",
        ...parentField(parent, "1"),
      });
      await expectRejectedBooking(fullRes, parent.id);
      await expectNoBooking(child);
    });

    test("a daily child under a dateless (standard) parent is rejected", async () => {
      // The standard parent produces no date, so a daily child can never be
      // dated — the parent is treated as sold out (defensive: admin blocks this
      // edge, but the gate must not fold a child onto a null date).
      const { parent } = await makeParent({
        children: [{ daily: true }],
        parent: { name: "Standard base" },
      });

      const res = await bookParent(parent.slug, parentField(parent, "1"));
      await expectRejectedBooking(
        res,
        parent.id,
        "Standard base has no available options right now.",
      );
    });
  },
);
