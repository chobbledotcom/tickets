import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { listingsTable } from "#shared/db/listings/records.ts";
import { publicDailyParentWithMondayChild } from "#test/lib/server-parents-booking/_shared-setup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookableStartDates } from "#test-utils/db-helpers/listings.ts";
import {
  apiGet,
  availabilityJson,
  expectChildAvailability,
  makeParent,
  makeParentWithDeactivatedChild,
} from "#test-utils/parents.ts";
import { enablePublicApi } from "#test-utils/settings.ts";

describeWithEnv(
  "server > parents booking — JSON API availability",
  { db: true, triggers: true },
  () => {
    test("a child listing availability endpoint is not bookable (404)", async () => {
      await enablePublicApi();
      const { child } = await makeParent();
      const res = await apiGet(`/api/listings/${child.slug}/availability`);
      expect(res.status).toBe(404);
    });

    test("a parent with no bookable child reports unavailable in API availability", async () => {
      await enablePublicApi();
      const { parent } = await makeParent({ children: [{ maxAttendees: 0 }] });
      expect((await availabilityJson(parent.slug)).available).toBe(false);
    });

    test("a parent with a bookable child stays available in API availability", async () => {
      await enablePublicApi();
      const { parent } = await makeParent();
      expect((await availabilityJson(parent.slug)).available).toBe(true);
    });

    test("API availability of a parent reports per-child availability", async () => {
      await enablePublicApi();
      const { parent, children } = await makeParent({
        children: [{}, { maxAttendees: 0 }],
      });
      const okChild = children[0]!;
      const fullChild = children[1]!;
      expectChildAvailability(
        await availabilityJson(parent.slug),
        okChild,
        fullChild,
      );
    });

    test("API availability reports an inactive child unavailable", async () => {
      await enablePublicApi();
      // A second active child keeps the parent itself bookable, so the response
      // carries the per-child availability array. The inactive child has spare
      // capacity but the booking fold rejects it (childActive), so it must report
      // `available: false` rather than advertising spots the booking POST refuses.
      const { parent, okChild, inactiveChild } =
        await makeParentWithDeactivatedChild();
      expectChildAvailability(
        await availabilityJson(parent.slug),
        okChild,
        inactiveChild,
      );
    });

    test("API availability reports a registration-closed child unavailable", async () => {
      await enablePublicApi();
      // The second child's registration has closed (closes_at in the past); like
      // the inactive case it has spare capacity but the fold rejects it
      // (childOpen), so it must report `available: false`.
      const { parent, children } = await makeParent({ children: [{}, {}] });
      const okChild = children[0]!;
      const closedChild = children[1]!;
      await listingsTable.update(closedChild.id, {
        closesAt: "2000-01-01T00:00:00.000Z",
      });
      expectChildAvailability(
        await availabilityJson(parent.slug),
        okChild,
        closedChild,
      );
    });

    test("API availability of a daily parent with no date reports per-child availability", async () => {
      await enablePublicApi();
      // No `date` query param: a daily child's availability is checked date-less
      // (its own cumulative capacity), so a client still sees which children
      // exist before choosing a date.
      const { parent, child } = await makeParent({
        children: [{ daily: true }],
        parent: { daily: true },
      });
      expect((await availabilityJson(parent.slug)).children).toEqual([
        { available: true, slug: child.slug },
      ]);
    });

    test("a daily parent's availability is false for a date no child can serve", async () => {
      // The parent is bookable every weekday, but its only (daily) child is
      // bookable only on Mondays. A date the child cannot serve must report
      // `available: false` even though the parent's OWN row has capacity — the
      // availability endpoint must honour the child-date union, matching the
      // detail endpoint and the booking fold.
      const { parent, child } = await publicDailyParentWithMondayChild();

      const parentDates = await bookableStartDates(parent.id);
      const childDates = new Set(await bookableStartDates(child.id));
      const servable = parentDates.find((d) => childDates.has(d))!;
      const unservable = parentDates.find((d) => !childDates.has(d))!;

      expect((await availabilityJson(parent.slug, unservable)).available).toBe(
        false,
      );
      expect((await availabilityJson(parent.slug, servable)).available).toBe(
        true,
      );
    });

    test("API availability reports a daily child unavailable when it can't serve the date", async () => {
      await enablePublicApi();
      // Parent has two daily children: A serves all days, B serves only Monday.
      // When the buyer picks a non-Monday date, childA is available but childB
      // is not — even though the parent-level keepParentDailyDatesChildrenCanServe check
      // passes (childA covers the date). Fix B ensures buildChildAvailability
      // checks each child's own calendar, not just capacity.
      const { parent, children } = await makeParent({
        children: [{ daily: true }, { bookableDays: ["Monday"], daily: true }],
        parent: { daily: true },
      });
      const [childA, childB] = children;

      const parentDates = await bookableStartDates(parent.id);
      const childBDates = new Set(await bookableStartDates(childB!.id));
      // A date the parent and childA serve but childB does not (non-Monday).
      const nonMondayDate = parentDates.find((d) => !childBDates.has(d))!;

      const body = await availabilityJson(parent.slug, nonMondayDate);
      // Parent is available (childA covers the date).
      expect(body.available).toBe(true);
      // ChildA reports available; childB does not.
      expectChildAvailability(body, childA!, childB!);
    });
  },
);
