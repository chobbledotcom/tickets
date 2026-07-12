// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { KIND } from "#shared/accounting/kinds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  adminPost,
  createServicingHold,
  editServiceCost,
  expectRejects,
  recordServiceCost,
} from "#test-utils/servicing.ts";
import {
  expectCostFormError,
  listingCostOf,
  recordBoilerCost,
  SERVICE_DATE,
  transfersOfKind,
} from "./ledger-helpers.ts";

// jscpd:ignore-end

describeWithEnv("servicing §22 - cost validation", { db: true }, () => {
  test("invalid create cost amounts write no service_cost transfer (form error, not 500)", async () => {
    const { id, listing } = await createServicingHold();
    const before = (await transfersOfKind(KIND.serviceCost)).length;
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
    const other = await createTestListing({ maxAttendees: 10, name: "Other" });
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
    const before = (await transfersOfKind(KIND.serviceCost)).length;
    for (const amount of ["", "-5", "abc", "0"]) {
      const response = await adminPost(
        `/admin/servicing/${id}/cost/${costId}`,
        { amount },
      );
      await expectCostFormError(response, id, before);
    }
    expect(await listingCostOf(listing.id)).toBe(9000);
  });

  test("a cost line targets a listing the event actually holds (allocation rule)", async () => {
    const { id } = await createServicingHold({ name: "Held" });
    const other = await createTestListing({ maxAttendees: 10, name: "Other" });
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
});
