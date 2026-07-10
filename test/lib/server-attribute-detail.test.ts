import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { AttributeWithOptions } from "#shared/db/attributes.ts";
import type { Listing } from "#shared/types.ts";
import {
  adminFormPost,
  adminGet,
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
  createTestListing,
  describeWithEnv,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils";

/** One attribute ("Difficulty": Easy/Hard) and one listing that selected only
 * the Easy option — the fixture both detail pages are asserted against. */
const createTaggedListing = async (): Promise<{
  attribute: AttributeWithOptions;
  listing: Listing;
}> => {
  const attribute = await createTestAttributeWithOptions("Difficulty", [
    "Easy",
    "Hard",
  ]);
  const listing = await createTestListing({ name: "Climbing" });
  await assignTestAttributeOptions(listing.id, [attribute.options[0]!]);
  return { attribute, listing };
};

describeWithEnv("server (admin attribute detail pages)", { db: true }, () => {
  describe("GET /admin/attributes/:id", () => {
    test("links each option to its edit page with a listings count", async () => {
      const { attribute } = await createTaggedListing();
      const [easy, hard] = attribute.options;

      const html = await expectHtmlResponse(
        await adminGet(`/admin/attributes/${attribute.id}`),
        200,
        '<th class="col-quantity">Listings</th>',
      );
      expect(html).toContain(
        `<a href="/admin/attributes/${attribute.id}/options/${
          easy!.id
        }/edit">Easy</a>`,
      );
      expect(html).toContain(
        `<a href="/admin/attributes/${attribute.id}/options/${
          hard!.id
        }/edit">Hard</a>`,
      );
      // Easy is set on one listing; Hard on none.
      expect(html).toContain('<td class="col-quantity">1</td>');
      expect(html).toContain('<td class="col-quantity">0</td>');
    });

    test("lists each listing using the attribute with its selected options", async () => {
      const { attribute, listing } = await createTaggedListing();
      const bothListing = await createTestListing({ name: "Both options" });
      await assignTestAttributeOptions(bothListing.id, attribute.options);

      const html = await expectHtmlResponse(
        await adminGet(`/admin/attributes/${attribute.id}`),
        200,
        "Listings using this attribute",
      );
      expect(html).toContain(
        `<a href="/admin/listing/${listing.id}">Climbing</a>`,
      );
      expect(html).toContain("<td>Easy</td>");
      // A listing with several options appears once, options in option order.
      expect(html).toContain(
        `<a href="/admin/listing/${bothListing.id}">Both options</a>`,
      );
      expect(html).toContain("<td>Easy, Hard</td>");
    });

    test("mutes deactivated listings in the listings table", async () => {
      const { attribute, listing } = await createTaggedListing();
      await adminFormPost(`/admin/listing/${listing.id}/deactivate`, {
        confirm_identifier: "Climbing",
      });

      const html = await expectHtmlResponse(
        await adminGet(`/admin/attributes/${attribute.id}`),
        200,
      );
      expect(html).toContain(
        `<a class="muted" href="/admin/listing/${listing.id}">Climbing</a>`,
      );
    });

    test("shows the empty state when no listings use the attribute", async () => {
      const attribute = await createTestAttributeWithOptions("Season", [
        "Spring",
      ]);

      await expectHtmlResponse(
        await adminGet(`/admin/attributes/${attribute.id}`),
        200,
        "No listings have this attribute set yet.",
      );
    });
  });

  describe("GET /admin/attributes/:id/options/:optionId/edit", () => {
    testRequiresAuth("/admin/attributes/1/options/1/edit");

    test("returns 404 for a missing attribute or option", async () => {
      const attribute = await createTestAttributeWithOptions("Missing", [
        "Only",
      ]);

      expectStatus(404)(
        await adminGet("/admin/attributes/999999/options/1/edit"),
      );
      expectStatus(404)(
        await adminGet(`/admin/attributes/${attribute.id}/options/999999/edit`),
      );
    });

    test("shows the option form, context, listings, and delete link", async () => {
      const { attribute, listing } = await createTaggedListing();
      const easy = attribute.options[0]!;

      const html = await expectHtmlResponse(
        await adminGet(
          `/admin/attributes/${attribute.id}/options/${easy.id}/edit`,
        ),
        200,
        "Edit Option",
        "Option for: Difficulty",
        "Listings using this option",
        "Set on 1 listing.",
      );
      expect(html).toContain('value="Easy"');
      expect(html).toContain(
        `<a href="/admin/listing/${listing.id}">Climbing</a>`,
      );
      expect(html).toContain(`href="/admin/attributes/${attribute.id}"`);
      expect(html).toContain(
        `<a class="danger" href="/admin/attributes/${attribute.id}/options/${easy.id}/delete">Delete Option</a>`,
      );
    });

    test("only lists listings that selected this option", async () => {
      const { attribute } = await createTaggedListing();
      const hard = attribute.options[1]!;
      const hardListing = await createTestListing({ name: "Hard only" });
      await assignTestAttributeOptions(hardListing.id, [hard]);

      const html = await expectHtmlResponse(
        await adminGet(
          `/admin/attributes/${attribute.id}/options/${hard.id}/edit`,
        ),
        200,
        "Hard only",
      );
      expect(html).not.toContain("Climbing");
    });

    test("shows the empty state and plural count when no listings use the option", async () => {
      const { attribute } = await createTaggedListing();
      const hard = attribute.options[1]!;

      await expectHtmlResponse(
        await adminGet(
          `/admin/attributes/${attribute.id}/options/${hard.id}/edit`,
        ),
        200,
        "Set on 0 listings.",
        "No listings have this option set yet.",
      );
    });
  });
});
