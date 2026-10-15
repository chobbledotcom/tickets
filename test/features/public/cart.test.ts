/**
 * How a cart URL turns its slugs into the items on the booking page: which
 * slugs are kept, which are dropped, and when the page falls through to the
 * plain multi-listing path.
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleCartBySlugs } from "#routes/public/cart.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { createFreePackage } from "#test-utils/packages.ts";

/** The cart page for these slugs, or null when the cart holds no package. */
const cartResponse = (slugs: string[]): Promise<Response | null> =>
  handleCartBySlugs(
    mockRequest(`/ticket/${slugs.join("+")}`),
    slugs,
    undefined,
  );

/** The rendered cart page, failing loudly when the cart fell through. */
const cartHtml = async (slugs: string[]): Promise<string> => {
  const response = await cartResponse(slugs);
  if (response === null) throw new Error(`No cart page for ${slugs.join("+")}`);
  return response.text();
};

/** How many times `needle` appears in `html`. */
const countOf = (html: string, needle: string): number =>
  html.split(needle).length - 1;

describeWithEnv("cart slug resolution", { db: true }, () => {
  test("falls through when no slug names a package", async () => {
    const listing = await createTestListing({ maxAttendees: 5, name: "Solo" });

    expect(await cartResponse([listing.slug])).toBeNull();
  });

  test("shows a package beside a listing added by its own slug", async () => {
    const { group } = await createFreePackage("Camp kit", "Kit tent");
    const solo = await createTestListing({
      maxQuantity: 5,
      name: "Lantern",
      unitPrice: 0,
    });

    const html = await cartHtml([group.slug, solo.slug]);
    assertStringIncludes(html, `name="package_quantity_${group.id}"`);
    assertStringIncludes(html, `name="quantity_${solo.id}"`);
    assertStringIncludes(html, "Kit tent");
    assertStringIncludes(html, "Lantern");
  });

  test("keeps one row for a listing named twice", async () => {
    const { group } = await createFreePackage("Twice kit", "Twice tent");
    const solo = await createTestListing({
      maxQuantity: 5,
      name: "Repeated lantern",
      unitPrice: 0,
    });

    const html = await cartHtml([group.slug, solo.slug, solo.slug]);
    expect(countOf(html, `name="quantity_${solo.id}"`)).toBe(1);
  });

  test("keeps one section for a package named twice", async () => {
    const { group } = await createFreePackage("Repeated kit", "Repeated tent");
    const other = await createFreePackage("Other kit", "Other tent");

    const html = await cartHtml([group.slug, group.slug, other.group.slug]);
    expect(countOf(html, `name="package_quantity_${group.id}"`)).toBe(1);
    expect(countOf(html, `name="package_quantity_${other.group.id}"`)).toBe(1);
  });

  test("drops a listing that is no longer on sale", async () => {
    const { group } = await createFreePackage("Live kit", "Live tent");
    const gone = await createTestListing({
      maxQuantity: 5,
      name: "Withdrawn lantern",
      unitPrice: 0,
    });
    await deactivateTestListing(gone.id);

    const html = await cartHtml([group.slug, gone.slug]);
    assert(
      !html.includes(`name="quantity_${gone.id}"`),
      "the value should not contain the searched item",
    );
    assertStringIncludes(html, "Live tent");
  });

  test("shows a package on its own", async () => {
    const { group } = await createFreePackage("Lone kit", "Lone tent");

    const html = await cartHtml([group.slug]);
    assertStringIncludes(html, `name="package_quantity_${group.id}"`);
    assertStringIncludes(html, "Lone tent");
  });
});
