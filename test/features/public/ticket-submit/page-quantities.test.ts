/**
 * Direct tests for the page quantities at form parse: a standalone listing
 * reads its quantity box, and a package count spreads over the package's
 * members.
 */

/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { packageQuantityFieldName } from "#booking/tree.ts";
import { resolvePageQuantities } from "#routes/public/ticket-submit/parse.ts";
import { FormParams } from "#shared/form-data.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import type { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { hiddenPackageWithMember } from "#test-utils/hidden-package.ts";
import {
  pageBookingTree,
  quantityForm,
  ticketContext,
} from "#test-utils/ticket-ctx.ts";

/* jscpd:ignore-end */

describeWithEnv("ticket-submit parse", { db: true }, () => {
  describe("resolvePageQuantities", () => {
    const resolvedQuantities = async (
      listingIds: number[],
      form: FormParams,
      group?: Awaited<ReturnType<typeof createHiddenPackageGroup>>,
    ) => {
      const ctx = await ticketContext(listingIds, group);
      return resolvePageQuantities(form, ctx, pageBookingTree(ctx));
    };

    test("reads each standalone listing's chosen quantity", async () => {
      const listing = await createTestListing({ maxQuantity: 5 });

      const { quantities } = await resolvedQuantities(
        [listing.id],
        quantityForm({ [listing.id]: 2 }),
      );
      expect(quantities.get(listing.id)).toBe(2);
    });

    /** A hidden package and one member it can book. */
    const mysteryBoxMember = async () => {
      const { ctx, group, member } = await hiddenPackageWithMember();
      return {
        ctx,
        form: (count: string) => {
          const form = new FormParams();
          form.set(packageQuantityFieldName(group.id), count);
          return form;
        },
        group,
        member,
      };
    };

    test("multiplies one package count across the package's member", async () => {
      const box = await mysteryBoxMember();

      const { quantities } = await resolvedQuantities(
        [box.member.id],
        box.form("2"),
        box.group,
      );
      expect(quantities.get(box.member.id)).toBe(2);
    });

    test("books nothing when the package count carries no number", async () => {
      const box = await mysteryBoxMember();

      const { quantities } = await resolvedQuantities(
        [box.member.id],
        box.form("abc"),
        box.group,
      );
      expect(quantities.get(box.member.id) ?? 0).toBe(0);
    });
  });
});
