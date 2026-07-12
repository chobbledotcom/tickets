/**
 * Servicing §22 — cost idempotency & replay protection.
 *
 * A recorded cost carries a deterministic reference (or a per-render form key),
 * so a browser retry / double-submit records the cost once, not twice. Reusing
 * a key with a *changed* payload (amount or memo) is never a silent success —
 * the route flashes an error and the data layer throws `COST_REPLAY_MISMATCH`
 * rather than replaying a stale leg.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import {
  expectFlashError,
  expectFlashSuccess,
  parseFlashCookie,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  adminPost,
  createServicingHold,
  expectRejects,
  listingCostOf,
  recordServiceCost,
} from "#test-utils/servicing.ts";
import { SERVICE_DATE, transfersOfKind } from "#test-utils/servicing-ledger.ts";

// jscpd:ignore-end

describeWithEnv(
  "servicing §22 — cost idempotency & replay",
  { db: true },
  () => {
    test("posting a cost is idempotent (same deterministic reference adds no second leg)", async () => {
      const { id, listing } = await createServicingHold();
      const ref = `cost-${id}-${listing.id}`;
      await recordServiceCost({
        amount: 9000,
        listingId: listing.id,
        memo: "Boiler part",
        occurredAt: SERVICE_DATE,
        reference: ref,
        servicingId: id,
      });
      await recordServiceCost({
        amount: 9000,
        listingId: listing.id,
        memo: "Boiler part",
        occurredAt: SERVICE_DATE,
        reference: ref,
        servicingId: id,
      });
      expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
      expect(await listingCostOf(listing.id)).toBe(9000);
    });

    test("a double-submit of the cost form records once and reports a clean success (idempotency key)", async () => {
      // The cost form carries a per-render idempotency key the route passes as the
      // ledger reference, so a browser retry / double-click of the same form posts
      // the cost once — not twice. The hold is DATELESS, so the route stamps a
      // fresh `occurredAt = new Date()` on each POST; the retry must still be
      // treated as a clean idempotent success (occurredAt is not compared), not an
      // error, which is the exact case the key exists to cover.
      const { id, listing } = await createServicingHold();
      const postCost = (idempotencyKey: string) =>
        adminPost(`/admin/servicing/${id}`, {
          amount: "90.00",
          cost_idempotency_key: idempotencyKey,
          memo: "Boiler part",
          target_listing_id: String(listing.id),
        });
      // Fixed keys (not random) so the test is deterministic and reproducible.
      const key = "idem-double-submit";
      await postCost(key);
      const retried = await postCost(key); // same form, double-submit
      expect(retried.status).toBe(302);
      // The retry is a success flash, NOT a COST_REPLAY_MISMATCH error.
      expect(parseFlashCookie(retried).error).toBeUndefined();
      expectFlashSuccess(retried);
      expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
      expect(await listingCostOf(listing.id)).toBe(9000);
      // A separate submission (a different key) posts a second, independent cost.
      await postCost("idem-double-submit-2");
      expect((await transfersOfKind(KIND.serviceCost)).length).toBe(2);
      expect(await listingCostOf(listing.id)).toBe(18000);
    });

    test("reusing an idempotency key with a changed amount errors, never a silent false success", async () => {
      // Bug: recordServiceCost short-circuited on the stored reference without
      // checking the payload, so a reused key (e.g. a bfcached form the operator
      // edited before resubmitting) reported success for the NEW amount while
      // recording nothing. The second submit must either post the change or fail
      // — never silently keep the old £90 while claiming to record £50.
      const { id, listing } = await createServicingHold();
      const key = "idem-changed-amount";
      const postCost = (amount: string) =>
        adminPost(`/admin/servicing/${id}`, {
          amount,
          cost_idempotency_key: key,
          memo: "Boiler part",
          target_listing_id: String(listing.id),
        });
      await postCost("90.00");
      const changed = await postCost("50.00"); // same key, different amount
      // Exactly one cost leg exists, and it is NOT a silent success storing £50.
      expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
      expect(await listingCostOf(listing.id)).toBe(9000);
      // The distinguishing signal from the old false-success: the second submit
      // carries an ERROR flash, not a "Recorded cost 50.00" success flash.
      expect(parseFlashCookie(changed).success).toBeUndefined();
      expectFlashError(changed);
      const { getServicingCosts } = await import(
        "#shared/db/attendees/servicing.ts"
      );
      const costs = await getServicingCosts(id);
      expect(costs.map((c) => c.amount)).toEqual([9000]);
    });

    test("reusing an idempotency key with only the memo changed does not silently keep the old memo", async () => {
      // The cost reference derived from amount/listing/date omits the memo, so a
      // memo-only change under the same key would previously short-circuit and
      // preserve the stale memo while reporting success.
      const { id, listing } = await createServicingHold();
      const key = "idem-changed-memo";
      const postCost = (memo: string) =>
        adminPost(`/admin/servicing/${id}`, {
          amount: "90.00",
          cost_idempotency_key: key,
          memo,
          target_listing_id: String(listing.id),
        });
      await postCost("Original memo");
      const changed = await postCost("Edited memo"); // same key, changed memo
      expect(changed.status).toBe(302);
      // Rejected with an error flash, not a false success (a flash-less redirect
      // would also leave success undefined, so assert the error is set too).
      expect(parseFlashCookie(changed).success).toBeUndefined();
      expectFlashError(changed);
      // Still exactly one cost, and the stored memo is the original — the edit was
      // rejected, not silently swallowed.
      const { getServicingCosts } = await import(
        "#shared/db/attendees/servicing.ts"
      );
      const costs = await getServicingCosts(id);
      expect(costs).toHaveLength(1);
      expect(costs[0]!.memo).toBe("Original memo");
    });

    test("recordServiceCost throws COST_REPLAY_MISMATCH when a stored reference's payload changed", async () => {
      // The data-layer guard behind the route form-error: same reference, changed
      // amount → a loud throw, never a stale-leg replay.
      const { id, listing } = await createServicingHold();
      const { COST_REPLAY_MISMATCH } = await import(
        "#shared/db/attendees/servicing.ts"
      );
      const base = {
        listingId: listing.id,
        memo: "Boiler part",
        occurredAt: SERVICE_DATE,
        reference: "reused-key",
        servicingId: id,
      };
      await recordServiceCost({ ...base, amount: 9000 });
      await expectRejects(
        recordServiceCost({ ...base, amount: 5000 }),
        COST_REPLAY_MISMATCH,
      );
      // Nothing new landed.
      expect((await transfersOfKind(KIND.serviceCost)).length).toBe(1);
      expect(await listingCostOf(listing.id)).toBe(9000);
    });
  },
);
