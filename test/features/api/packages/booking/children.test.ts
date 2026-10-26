import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { groups } from "#db/groups.ts";
import {
  apiBookPackage,
  bookingRows,
  describePackageBooking,
  fixedPackage,
  twoChildAddons,
} from "#test/features/api/packages/helpers.ts";

describePackageBooking(() => {
  for (const concealed of [false, true]) {
    test(`POST shapes a child-total error by the package's visibility (${concealed})`, async () => {
      const { a, group } = await fixedPackage("Mix Kit", "mix-kit");
      const { child } = await twoChildAddons(a, "Mix Kit");
      await groups.table.update(group.id, { hidePackageListings: concealed });

      // Member A books 2 units per package; a single chosen add-on undershoots.
      const { body, response } = await apiBookPackage(group.slug, {
        children: [{ parent: a.slug, quantity: 1, slug: child.slug }],
        quantity: 1,
      });
      expect(response.status).toBe(400);
      // A concealed package's refusals are one generic message, so a probe
      // cannot distinguish a real member from a guess; named packages keep
      // their specific diagnostics.
      expect(body.error).toBe(
        concealed
          ? "This package cannot be booked with those choices."
          : `Choose 1 more add-on for ${a.name}.`,
      );
      expect(await bookingRows(a.id)).toHaveLength(0);
    });
  }

  test("POST folds a member's chosen child and rejects unknown or malformed selections", async () => {
    const { a, group } = await fixedPackage("Child Kit", "child-kit");
    const { child, childB } = await twoChildAddons(a, "Child Kit");

    // Member A books 2 units per package, so its child mix must total 2.
    const { body, response } = await apiBookPackage(group.slug, {
      children: [
        { parent: a.slug, quantity: 1, slug: child.slug },
        { parent: a.slug, quantity: 1, slug: childB.slug },
      ],
      quantity: 1,
    });
    expect(response.status).toBe(200);
    // 2500 bundle + 300 + 400 chosen add-ons, exactly once.
    expect(body.booking!.amountOwed).toBe(3200);
    const childRow = (await bookingRows(child.id))[0]!;
    expect(Number(childRow.parent_listing_id)).toBe(a.id);

    const unknown = await apiBookPackage(group.slug, {
      children: [{ parent: "not-a-member", quantity: 1, slug: child.slug }],
      quantity: 1,
    });
    expect(unknown.response.status).toBe(400);
    assertStringIncludes(unknown.body.error ?? "", "not a member");

    const malformed = await apiBookPackage(group.slug, {
      children: [{ quantity: 1, slug: child.slug }],
      quantity: 1,
    });
    expect(malformed.response.status).toBe(400);
    assertStringIncludes(malformed.body.error ?? "", "parent");

    // A garbage customPrice is a schema parse failure — never NaN stored as a
    // price.
    const badPrice = await apiBookPackage(group.slug, {
      children: [
        { customPrice: "x", parent: a.slug, quantity: 1, slug: child.slug },
      ],
      quantity: 1,
    });
    expect(badPrice.response.status).toBe(400);

    // A member that gates no children accepts no child selections either.
    const { b } = await fixedPackage("Childless Kit", "childless-kit");
    const childless = await apiBookPackage("childless-kit", {
      children: [{ parent: b.slug, quantity: 1, slug: child.slug }],
      quantity: 1,
    });
    expect(childless.response.status).toBe(400);
    assertStringIncludes(childless.body.error ?? "", "not a child");
  });
});
