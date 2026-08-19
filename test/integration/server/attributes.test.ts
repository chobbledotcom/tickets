import { expect } from "@std/expect";
import { beforeEach, describe, it as test } from "@std/testing/bdd";
import { setAdminFeatureEnabled } from "#db/admin-features.ts";
import { listingAttributeOptions } from "#db/attributes.ts";
import { handleRequest } from "#routes";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import {
  createTestListing,
  duplicateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import { adminGet, getTestSession } from "#test-utils/session.ts";
import { enableFeature } from "#test-utils/settings.ts";

const postRepeatedOptions = async (
  path: string,
  optionIds: number[],
): Promise<Response> => {
  const { cookie, csrfToken } = await getTestSession();
  const body = new URLSearchParams([["csrf_token", csrfToken]]);
  for (const optionId of optionIds) body.append("option_ids", String(optionId));
  return handleRequest(
    new Request(`http://localhost${path}`, {
      body: body.toString(),
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        host: "localhost",
      },
      method: "POST",
    }),
  );
};

describeWithEnv("server (admin attributes)", { db: true }, () => {
  describe("GET /admin/attributes", () => {
    testRequiresAuth("/admin/attributes");

    test("shows the empty state", async () => {
      await expectHtmlResponse(
        await adminGet("/admin/attributes"),
        200,
        "Listing Attributes",
        "No listing attributes yet.",
      );
    });

    test("lists existing attributes with option counts", async () => {
      await createTestAttributeWithOptions("Difficulty", ["Easy", "Hard"]);

      await expectHtmlResponse(
        await adminGet("/admin/attributes"),
        200,
        "Difficulty",
        "col-quantity",
        ">2</td>",
      );
    });
  });

  describe("listing attributes tab", () => {
    beforeEach(() => enableFeature("attributes"));

    testRequiresAuth("/admin/listing/1/attributes", {
      setup: async () => {
        await createTestListing({ name: "Auth listing" });
      },
    });

    testRequiresAuth("/admin/listing/1/attributes", {
      body: { option_ids: "1" },
      method: "POST",
      setup: async () => {
        await createTestListing({ name: "Auth listing post" });
      },
    });

    test("returns 404 for a missing listing", async () => {
      expectStatus(404)(await adminGet("/admin/listing/999999/attributes"));
      expectStatus(404)(
        await postRepeatedOptions("/admin/listing/999999/attributes", [1]),
      );
    });

    test("returns 404 without changing choices when Attributes is disabled", async () => {
      const listing = await createTestListing({ name: "Hidden attributes" });
      await setAdminFeatureEnabled("attributes", false);
      expectStatus(404)(
        await adminGet(`/admin/listing/${listing.id}/attributes`),
      );
      expectStatus(404)(
        await postRepeatedOptions(
          `/admin/listing/${listing.id}/attributes`,
          [1],
        ),
      );
      expect(await listingAttributeOptions.getIds(listing.id)).toEqual([]);
    });

    test("shows the empty state when no attributes exist", async () => {
      const listing = await createTestListing({ name: "No attributes" });

      await expectHtmlResponse(
        await adminGet(`/admin/listing/${listing.id}/attributes`),
        200,
        "Attributes for No attributes",
        "No attributes created yet.",
      );
    });

    test("shows no error box on a plain page load", async () => {
      const listing = await createTestListing({ name: "Calm tagged listing" });
      await createTestAttributeWithOptions("Season", ["Summer"]);

      const html = await expectHtmlResponse(
        await adminGet(`/admin/listing/${listing.id}/attributes`),
        200,
        "Season",
      );
      // The tab loader once received the framework's page-context object in
      // its `error` parameter, so every load showed an error box reading
      // "[object Object]".
      expect(html).not.toContain("[object Object]");
      expect(html).not.toContain('class="error"');
    });

    test("shows available options and checked selections", async () => {
      const listing = await createTestListing({ name: "Tagged listing" });
      const attribute = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
        "Hard",
      ]);
      await listingAttributeOptions.setIds(listing.id, [
        attribute.options[1]!.id,
      ]);

      const html = await expectHtmlResponse(
        await adminGet(`/admin/listing/${listing.id}/attributes`),
        200,
        "Difficulty",
        "Easy",
        "Hard",
      );
      expect(html).toContain(
        `checked name="option_ids" type="checkbox" value="${
          attribute.options[1]!.id
        }"`,
      );
      // Each attribute's options render as a row-based checkbox fieldset.
      expect(html).toContain('<fieldset class="checkboxes listing-section">');
    });

    test("shows attributes that do not have options yet", async () => {
      const listing = await createTestListing({ name: "No option listing" });
      await createTestAttributeWithOptions("Audience", []);

      await expectHtmlResponse(
        await adminGet(`/admin/listing/${listing.id}/attributes`),
        200,
        "Audience",
        "No options for this attribute yet.",
      );
    });

    test("saves repeated option ids and drops invalid ids", async () => {
      const listing = await createTestListing({ name: "Saved attributes" });
      const attribute = await createTestAttributeWithOptions("Format", [
        "Online",
        "In person",
      ]);

      const response = await postRepeatedOptions(
        `/admin/listing/${listing.id}/attributes`,
        [
          attribute.options[0]!.id,
          attribute.options[0]!.id,
          999_999,
          attribute.options[1]!.id,
        ],
      );

      await expectFlashRedirect(
        `/admin/listing/${listing.id}/attributes`,
        "Attributes updated",
      )(response);
      expect(await listingAttributeOptions.getIds(listing.id)).toEqual(
        attribute.options.map((option) => option.id),
      );
    });
  });

  describe("listing duplication", () => {
    test("copies attribute selections onto the duplicate", async () => {
      const source = await createTestListing({ name: "Attr Source" });
      const format = await createTestAttributeWithOptions("Format", [
        "Online",
        "In person",
      ]);
      await assignTestAttributeOptions(source.id, format.options);

      const duplicate = await duplicateTestListing(source.id, {
        name: "Attr Duplicate",
      });

      expect(await listingAttributeOptions.getIds(duplicate.id)).toEqual(
        format.options.map((option) => option.id),
      );
    });
  });
});
