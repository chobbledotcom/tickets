/**
 * Servicing §22 — cost validation & rejection.
 *
 * Bad cost input never reaches the ledger and never 500s. Invalid amounts and
 * target listings are rejected at the route as a form-error redirect; the data
 * layer throws for a non-positive/non-integer amount, a target the event does
 * not hold, an attempt to move a cost through another event, or a missing cost.
 * Every rejection leaves the ledger exactly as it was.
 */
// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import { allTransfers } from "#shared/accounting/queries.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminPost,
  createServicingHold,
  editServiceCost,
  expectRejects,
  listingCostOf,
  recordServiceCost,
} from "#test-utils/servicing.ts";
import {
  expectCostFormError,
  recordBoilerCost,
  SERVICE_DATE,
  transfersOfKind,
} from "#test-utils/servicing-ledger.ts";

// jscpd:ignore-end

describeWithEnv(
  "servicing §22 — cost validation & rejection",
  { db: true },
  () => {
    test("invalid create cost amounts write no service_cost transfer (form error, not 500)", async () => {
      // Empty, negative, non-numeric, and zero amounts must be rejected at the
      // route as a form-error redirect, never reach the ledger, and never 500.
      const { id, listing } = await createServicingHold();
      const before = (await allTransfers()).length;
      for (const amount of ["", "-5", "abc", "0"]) {
        const response = await adminPost(`/admin/servicing/${id}`, {
          amount,
          memo: "Bad",
          target_listing_id: String(listing.id),
        });
        await expectCostFormError(response, id, before);
      }
      expect(await listingCostOf(listing.id)).toBe(0);
    });

    test("an invalid create target_listing_id writes no service_cost transfer", async () => {
      const { id, listing } = await createServicingHold();
      const before = (await transfersOfKind(KIND.serviceCost)).length;
      for (const target of ["", "abc", "0", "-3"]) {
        const response = await adminPost(`/admin/servicing/${id}`, {
          amount: "90.00",
          memo: "Bad",
          target_listing_id: target,
        });
        expect(response.status).toBe(302);
        expect((await transfersOfKind(KIND.serviceCost)).length).toBe(before);
      }
      // listing.id is a positive int but the event does not hold a different
      // listing, so the allocation rule still blocks it (form error, no 500).
      const other = await createTestListing({
        maxAttendees: 10,
        name: "Other",
      });
      const response = await adminPost(`/admin/servicing/${id}`, {
        amount: "90.00",
        memo: "Bad",
        target_listing_id: String(other.id),
      });
      expect(response.status).toBe(302);
      expect((await transfersOfKind(KIND.serviceCost)).length).toBe(before);
      expect(await listingCostOf(listing.id)).toBe(0);
    });

    test("invalid edit cost amounts write no service_cost transfer (form error, not 500)", async () => {
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id);
      const before = (await allTransfers()).length;
      for (const amount of ["", "-5", "abc", "0"]) {
        const response = await adminPost(
          `/admin/servicing/${id}/cost/${costId}`,
          { amount },
        );
        await expectCostFormError(response, id, before);
      }
      // The original £90 cost is untouched — no delta leg landed.
      expect(await listingCostOf(listing.id)).toBe(9000);
    });

    test("a cost line targets a listing the event actually holds (allocation rule)", async () => {
      const { id } = await createServicingHold({ name: "Held" });
      const other = await createTestListing({
        maxAttendees: 10,
        name: "Other",
      });
      await expectRejects(
        recordServiceCost({
          amount: 9000,
          listingId: other.id,
          memo: "x",
          occurredAt: SERVICE_DATE,
          servicingId: id,
        }),
      );
    });

    test("editing a service cost cannot move it through another service event", async () => {
      const { id, listing } = await createServicingHold({ name: "Held" });
      await createTestListing({ maxAttendees: 10, name: "Other Listing" });
      const other = await createServicingHold({
        listing: { maxAttendees: 10, name: "Other Listing" },
        name: "Other",
      });
      const costId = await recordBoilerCost(id, listing.id);
      await expectRejects(
        editServiceCost(costId, { amount: 6000 }, other.id),
        /held listing/,
      );
    });

    test("recording a cost rejects non-positive and non-integer amounts", async () => {
      const { id, listing } = await createServicingHold();
      for (const amount of [0, -1, 1.5]) {
        await expectRejects(
          recordServiceCost({
            amount,
            listingId: listing.id,
            memo: "Bad cost",
            occurredAt: SERVICE_DATE,
            servicingId: id,
          }),
          /positive integer/,
        );
      }
    });

    test("editing a missing service cost reports not found", async () => {
      await expectRejects(
        editServiceCost(999_999, { amount: 1000 }),
        /not found/,
      );
    });

    test("editServiceCost rejects non-positive and non-integer target amounts (defence-in-depth)", async () => {
      const { id, listing } = await createServicingHold();
      const costId = await recordBoilerCost(id, listing.id);
      for (const amount of [0, -1, 1.5]) {
        await expectRejects(
          editServiceCost(costId, { amount }),
          /positive integer/,
        );
      }
    });
  },
);
