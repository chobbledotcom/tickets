/** writePackageMembersTx package-guard tests: the sold-hidden-package recheck,
 *  the visible-package allow path, and the member-rule recheck. Split from
 *  membership.test.ts so each file stays under the ~400-line target. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { withTransaction } from "#db/client.ts";
import {
  assignListingsToGroup,
  type PackageFlags,
  readPackageFlagsTxOrNull,
  writePackageMembersTx,
} from "#db/groups/membership.ts";
import { getGroupPackagePrices, setGroupPackageMembers } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { t } from "#i18n";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createSoldPackageMember,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

/** Runs writePackageMembersTx inside a transaction and returns the resulting
 *  package price for the group's first member, so each allow-path test shares
 *  one call shape. */
const runAndFirstPrice = async (
  groupId: number,
  existing: PackageFlags,
  isPackage: boolean,
): Promise<number | null> => {
  await withTransaction(async (tx) => {
    await writePackageMembersTx(tx, groupId, existing, { isPackage }, []);
  });
  const prices = await getGroupPackagePrices(groupId);
  return prices[0]!.package_price;
};

describeWithEnv(
  "db > groups > writePackageMembersTx guards",
  { db: true },
  () => {
    test("reads only package flags from the transaction view", async () => {
      const ordinary = await createTestGroup({ name: "Flag reader ordinary" });
      const hidden = await createHiddenPackageGroup("Flag reader hidden");

      const flags = await withTransaction(async (tx) => [
        await readPackageFlagsTxOrNull(tx, ordinary.id),
        await readPackageFlagsTxOrNull(tx, hidden.id),
        await readPackageFlagsTxOrNull(tx, 999_999),
      ]);

      expect(flags).toEqual([
        { hide_package_listings: false, is_package: false },
        { hide_package_listings: true, is_package: true },
        null,
      ]);
    });

    test("writePackageMembersTx rolls back un-packaging a sold hidden package", async () => {
      const { group } = await createSoldPackageMember(
        "Tx block unpackage",
        true,
      );
      const existing = { hide_package_listings: true, is_package: true };

      await expect(
        withTransaction(async (tx) => {
          await writePackageMembersTx(
            tx,
            group.id,
            existing,
            { isPackage: false },
            [],
          );
        }),
      ).rejects.toThrow(t("error.sold_hidden_package"));
    });

    test("writePackageMembersTx allows un-packaging a sold visible package", async () => {
      const { group } = await createSoldPackageMember(
        "Tx visible unpackage",
        false,
      );
      const existing = { hide_package_listings: false, is_package: true };

      expect(await runAndFirstPrice(group.id, existing, false)).toBeNull();
    });

    test("writePackageMembersTx allows un-packaging an unsold hidden package", async () => {
      const group = await createHiddenPackageGroup("Tx ok unpackage");
      const member = await createTestListing({
        groupId: group.id,
        name: "Tx ok member",
      });
      await setGroupPackageMembers(group.id, [
        { listingId: member.id, price: 500 },
      ]);
      const existing = { hide_package_listings: true, is_package: true };

      expect(await runAndFirstPrice(group.id, existing, false)).toBeNull();
    });

    test("writePackageMembersTx allows keeping a sold hidden package packaged", async () => {
      const { group, member } = await createSoldPackageMember(
        "Tx stay package",
        true,
      );
      await setGroupPackageMembers(group.id, [
        { listingId: member.id, price: 700 },
      ]);
      const existing = { hide_package_listings: true, is_package: true };

      // Pass undefined so existing overrides are left untouched.
      await withTransaction(async (tx) => {
        await writePackageMembersTx(
          tx,
          group.id,
          existing,
          { isPackage: true },
          undefined,
        );
      });

      const prices = await getGroupPackagePrices(group.id);
      expect(prices[0]!.package_price).toBe(700);
    });

    test("writePackageMembersTx rechecks package member rules for an existing package", async () => {
      const group = await createHiddenPackageGroup("Tx recheck members");
      const parent = await createTestListing({
        groupId: group.id,
        name: "Tx recheck parent",
      });
      const child = await createTestListing({ name: "Tx recheck child" });
      await listingChildren.setIds(parent.id, [child.id]);
      const existing = { hide_package_listings: true, is_package: true };

      await expect(
        withTransaction(async (tx) => {
          await writePackageMembersTx(
            tx,
            group.id,
            existing,
            { isPackage: true },
            [],
          );
        }),
      ).rejects.toThrow(
        t("error.package_member_gates_children_hidden", {
          name: "Tx recheck parent",
        }),
      );
    });

    test("a group becoming a hidden package rechecks its member edges", async () => {
      const group = await createTestGroup({ name: "New Hidden Package" });
      const parent = await createTestListing({ name: "New Package Parent" });
      const child = await createTestListing({ name: "New Package Child" });
      await listingChildren.setIds(parent.id, [child.id]);
      await assignListingsToGroup([parent.id], group.id);

      await expect(
        withTransaction(async (tx) => {
          await tx.execute({
            args: [group.id],
            sql: "UPDATE groups SET is_package = 1, hide_package_listings = 1 WHERE id = ?",
          });
          await writePackageMembersTx(
            tx,
            group.id,
            { hide_package_listings: false, is_package: false },
            { isPackage: true },
            undefined,
          );
        }),
      ).rejects.toMatchObject({
        message: t("error.package_member_gates_children_hidden", {
          name: parent.name,
        }),
        name: "TransactionValidationError",
      });
    });

    test("a deleted package group leaves not-found handling to its caller", async () => {
      await expect(
        withTransaction((tx) =>
          writePackageMembersTx(
            tx,
            999_999,
            null,
            { isPackage: true },
            undefined,
          ),
        ),
      ).resolves.toBeUndefined();
    });
  },
);
