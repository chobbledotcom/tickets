/**
 * While somebody holds a ticket to a hidden package, it cannot be deleted or
 * turned back into an ordinary group: either would make their ticket start
 * naming the things inside. Once nothing is sold, or nothing is hidden, both
 * are allowed again.
 *
 * Sits beside the story `@story:bookings.selling-things-as-one-bundle`: these
 * own the branch cover, and the invariants that have no journey behind them.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#shared/db/groups.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
// jscpd:ignore-start
import { adminFormPost, apiRequest } from "#test-utils/session.ts";
import {
  editFields,
  hiddenPackageWithBooking,
  loadListing,
  member,
  sellPackageTicket,
} from "./helpers.ts";

// jscpd:ignore-end

describeWithEnv(
  "server (admin group packages) — pulling apart a package people have bought",
  { db: true },
  () => {
    test("un-packaging a sold hidden package is rejected", async () => {
      // Clearing is_package would stop the stored package_group_id resolving,
      // taking the same name-revealing fall-back path deletion is blocked from.
      const { group } = await hiddenPackageWithBooking("Lock Kit", "lock-kit");
      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/edit`,
        {
          ...editFields("Lock Kit", "lock-kit"),
        },
      );
      expect(response.status).toBe(302);
      const kept = (await groups.table.read.one({ id: group.id }))!;
      expect(kept.is_package).toBe(true);
      expect(kept.hide_package_listings).toBe(true);
    });

    test("allows deleting a hidden package with no sold tickets", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "Empty Kit",
        slug: "empty-kit",
      });
      await groups.table.update(group.id, { hidePackageListings: true });
      await member(group, "Empty Member");
      const { response } = await adminFormPost(
        `/admin/groups/${group.id}/delete`,
        { confirm_identifier: "Empty Kit" },
      );
      expect(response.status).toBe(302);
      expect(await groups.table.read.one({ id: group.id })).toBeNull();
    });

    test("the groups API blocks deleting a sold hidden package until un-hidden", async () => {
      const { group, memberListing } = await hiddenPackageWithBooking(
        "Api Kit",
        "api-kit",
      );
      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { confirm_identifier: "Api Kit" },
          method: "DELETE",
        }),
        400,
        (body) => {
          expect(String(body.error)).toContain(
            "hidden package has sold tickets",
          );
        },
      );
      expect(await groups.table.read.one({ id: group.id })).not.toBeNull();

      // After the explicit reveal, the API delete un-groups as before.
      await groups.table.update(group.id, { hidePackageListings: false });
      await assertJson(
        apiRequest(`/api/admin/groups/${group.id}`, {
          body: { confirm_identifier: "Api Kit" },
          method: "DELETE",
        }),
        200,
        (body) => {
          expect(body.status).toBe("ok");
        },
      );
      expect(await groups.table.read.one({ id: group.id })).toBeNull();
      expect(await loadListing(memberListing.id)).not.toBeNull();
    });

    test("says so loudly when a package ticket cannot be sold at all", async () => {
      const group = await createTestGroup({ isPackage: true, name: "NoSuch" });

      // Nothing to book against, so the booking cannot succeed. The helper the
      // other tests here lean on must fail rather than hand back an empty token
      // and let them check a sale that never happened.
      await expect(sellPackageTicket(999_999, group.id)).rejects.toThrow(
        "package booking failed",
      );
    });
  },
);
