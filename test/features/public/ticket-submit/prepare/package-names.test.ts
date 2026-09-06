import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { formatAtomicError } from "#booking/form.ts";
import { childQuantityFieldName } from "#booking/tree.ts";
import { getGroupById, groups } from "#db/groups.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { loadPagePackage } from "#routes/public/ticket-payment.ts";
import { prepareOrder } from "#routes/public/ticket-submit/prepare.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  prepareTestOrder,
  quantityForm,
  ticketContext,
} from "#test-utils/ticket-ctx.ts";
import type { ListingWithCount } from "#types";

const packageParent = async (
  childOptions: Parameters<typeof createTestListing>[0] = {},
) => {
  const group = await createHiddenPackageGroup("Mystery Box");
  const parent = await createTestListing({
    groupId: group.id,
    maxAttendees: 20,
    maxQuantity: 10,
    name: "Secret Parent",
    unitPrice: 500,
  });
  const child = await createTestListing({
    bookableAlone: true,
    maxAttendees: 20,
    maxQuantity: 10,
    name: "Secret Child",
    unitPrice: 300,
    ...childOptions,
  });
  await listingChildren.setIds(parent.id, [child.id]);
  const contextFor = async (...standalone: ListingWithCount[]) => {
    const ids = [
      ...new Set([parent.id, ...standalone.map((listing) => listing.id)]),
    ];
    const ctx = await ticketContext(ids, group);
    ctx.packages = [await loadPagePackage(group, [parent.id])];
    ctx.slugs = [group.slug, ...standalone.map((listing) => listing.slug)];
    return ctx;
  };
  return { child, contextFor, group, parent };
};

describeWithEnv("selected package names", { db: true }, () => {
  for (const standalone of [0, 1]) {
    test(`a package child's name follows its selected standalone quantity (${standalone})`, async () => {
      const { child, contextFor, group, parent } = await packageParent();
      const ctx = await contextFor(child);
      const result = await prepareTestOrder(
        ctx,
        quantityForm({ [child.id]: standalone }, { [group.id]: 1 }),
      );

      expect(
        result.pricingParams.items.map(
          ({ listingId, name, quantity, unitPrice }) => ({
            listingId,
            name,
            quantity,
            unitPrice,
          }),
        ),
      ).toEqual([
        { listingId: parent.id, name: group.name, quantity: 1, unitPrice: 500 },
        {
          listingId: child.id,
          name: standalone > 0 ? child.name : group.name,
          quantity: standalone + 1,
          unitPrice: 300,
        },
      ]);
    });
  }

  for (const namedQuantity of [0, 1]) {
    test(`a child keeps its name through a selected named parent (${namedQuantity})`, async () => {
      const { child, contextFor, group, parent } = await packageParent();
      const ctx = await contextFor(parent);
      const result = await prepareTestOrder(
        ctx,
        quantityForm({ [parent.id]: namedQuantity }, { [group.id]: 1 }),
      );

      expect(
        result.pricingParams.items.find((item) => item.listingId === child.id)
          ?.name,
      ).toBe(namedQuantity > 0 ? child.name : group.name);
      expect(
        result.pricingParams.items.find(
          (item) => item.packageGroupId === group.id,
        )?.name,
      ).toBe(group.name);
    });
  }

  for (const selectSharedChild of [false, true]) {
    test(`a named parent reveals only its selected children (${selectSharedChild})`, async () => {
      const { child, contextFor, group } = await packageParent();
      const namedParent = await createTestListing({
        maxAttendees: 20,
        name: "Named Parent",
      });
      const otherChild = await createTestListing({
        maxAttendees: 20,
        name: "Other Child",
      });
      await listingChildren.setIds(namedParent.id, [child.id, otherChild.id]);
      const ctx = await contextFor(namedParent);
      const form = quantityForm({ [namedParent.id]: 1 }, { [group.id]: 1 });
      form.set(
        childQuantityFieldName(
          namedParent.id,
          selectSharedChild ? child.id : otherChild.id,
        ),
        "1",
      );
      const result = await prepareTestOrder(ctx, form);

      expect(
        result.pricingParams.items.find((item) => item.listingId === child.id)
          ?.name,
      ).toBe(selectSharedChild ? child.name : group.name);
    });
  }

  test("an unselected concealed package does not rename another package's child", async () => {
    const { child, group, parent } = await packageParent();
    const other = await createHiddenPackageGroup("Other Mystery Box");
    const otherParent = await createTestListing({
      groupId: other.id,
      maxAttendees: 20,
      name: "Other Secret Parent",
    });
    await listingChildren.setIds(otherParent.id, [child.id]);
    const ctx = await ticketContext([parent.id, otherParent.id], group);
    ctx.packages = [
      await loadPagePackage(group, [parent.id]),
      await loadPagePackage(other, [otherParent.id]),
    ];
    ctx.slugs = [group.slug, other.slug];
    const result = await prepareTestOrder(
      ctx,
      quantityForm({}, { [group.id]: 1, [other.id]: 0 }),
    );

    expect(
      result.pricingParams.items.find((item) => item.listingId === child.id)
        ?.name,
    ).toBe(group.name);
  });

  test("a nonconcealing package keeps its child's name", async () => {
    const { child, group, parent } = await packageParent();
    await groups.table.update(group.id, { hidePackageListings: false });
    const visible = await getGroupById(group.id);
    if (!visible) throw new Error("Package is missing");
    const ctx = await ticketContext([parent.id], visible);
    ctx.slugs = [group.slug];
    const result = await prepareTestOrder(
      ctx,
      quantityForm({}, { [group.id]: 1 }),
    );

    expect(result.pricingParams.items.map((item) => item.name)).toEqual([
      parent.name,
      child.name,
    ]);
  });

  test("a concealed parent's invalid child total names the package", async () => {
    const { child, group, parent } = await packageParent();
    const ctx = await ticketContext([parent.id], group);
    ctx.slugs = [group.slug];
    const form = quantityForm({}, { [group.id]: 1 });
    form.set(childQuantityFieldName(parent.id, child.id), "2");
    const result = await prepareOrder(ctx, form);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a child quantity refusal");
    expect(result.error).toContain(group.name);
    expect(result.error).not.toContain(parent.name);
  });

  for (const namedFirst of [false, true]) {
    test(`a shared-child capacity error keeps its selected name (named first: ${namedFirst})`, async () => {
      const { child, contextFor, group } = await packageParent({
        maxAttendees: 1,
      });
      const namedParent = await createTestListing({
        maxAttendees: 20,
        name: "Named Parent",
      });
      await listingChildren.setIds(namedParent.id, [child.id]);
      const ctx = await contextFor(namedParent);
      if (namedFirst) ctx.listings.reverse();

      const result = await prepareOrder(
        ctx,
        quantityForm({ [namedParent.id]: 1 }, { [group.id]: 1 }),
      );

      expect(result).toEqual({
        error: formatAtomicError("capacity_exceeded", child.name),
        ok: false,
      });
    });
  }
});
