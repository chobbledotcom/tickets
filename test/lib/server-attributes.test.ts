import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  getAllAttributesWithOptions,
  getAttributeWithOptions,
  listingAttributeOptions,
  setListingAttributeOptions,
} from "#shared/db/attributes.ts";
import {
  adminFormPost,
  adminGet,
  assignTestAttributeOptions,
  createTestAttributeWithOptions,
  createTestListing,
  describeWithEnv,
  duplicateTestListing,
  expectFlash,
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
  getTestSession,
  testRequiresAuth,
} from "#test-utils";

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

const createAttributeViaRoute = async (name: string): Promise<number> => {
  const { response } = await adminFormPost("/admin/attributes", { name });
  expect(response.status).toBe(302);
  expectFlash(response, "Attribute created");
  const attribute = (await getAllAttributesWithOptions()).find(
    (item) => item.name === name,
  );
  expect(attribute).toBeTruthy();
  return attribute!.id;
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

  describe("attribute CRUD", () => {
    testRequiresAuth("/admin/attributes", {
      body: { name: "Auth attribute" },
      method: "POST",
    });

    test("creates an attribute and redirects to its detail page", async () => {
      const id = await createAttributeViaRoute("Difficulty");

      await expectHtmlResponse(
        await adminGet(`/admin/attributes/${id}`),
        200,
        "Difficulty",
        "No options yet.",
      );
    });

    test("redirects invalid attribute forms back to the right page", async () => {
      const id = await createAttributeViaRoute("Required fields");

      await expectFlashRedirect(
        "/admin/attributes",
        expect.any(String),
        false,
      )((await adminFormPost("/admin/attributes")).response);
      await expectFlashRedirect(
        `/admin/attributes/${id}`,
        expect.any(String),
        false,
      )((await adminFormPost(`/admin/attributes/${id}/edit`)).response);
      await expectFlashRedirect(
        `/admin/attributes/${id}`,
        expect.any(String),
        false,
      )((await adminFormPost(`/admin/attributes/${id}/options`)).response);
    });

    test("updates an attribute name", async () => {
      const id = await createAttributeViaRoute("Old name");

      const { response } = await adminFormPost(`/admin/attributes/${id}/edit`, {
        name: "New name",
      });

      await expectFlashRedirect(
        `/admin/attributes/${id}`,
        "Attribute updated",
      )(response);
      expect((await getAttributeWithOptions(id))?.name).toBe("New name");
    });

    test("returns 404 when changing a missing attribute", async () => {
      expectStatus(404)(
        (
          await adminFormPost("/admin/attributes/999999/edit", {
            name: "Missing",
          })
        ).response,
      );
      expectStatus(404)(
        (
          await adminFormPost("/admin/attributes/999999/options", {
            text: "Missing",
          })
        ).response,
      );
      expectStatus(404)(
        (await adminFormPost("/admin/attributes/999999/move-up")).response,
      );
    });

    test("adds, edits, and reorders options", async () => {
      const id = await createAttributeViaRoute("Format");
      await adminFormPost(`/admin/attributes/${id}/options`, {
        text: "Online",
      });
      await adminFormPost(`/admin/attributes/${id}/options`, {
        text: "In person",
      });
      const before = (await getAttributeWithOptions(id))!;
      const second = before.options[1]!;

      const edited = await adminFormPost(
        `/admin/attributes/${id}/options/${second.id}/edit`,
        { text: "In-person" },
      );
      await expectFlashRedirect(
        `/admin/attributes/${id}`,
        "Option updated",
      )(edited.response);
      await adminFormPost(
        `/admin/attributes/${id}/options/${second.id}/move-up`,
      );

      const after = (await getAttributeWithOptions(id))!;
      expect(after.options.map((option) => option.text)).toEqual([
        "In-person",
        "Online",
      ]);

      // Moving it back down restores the original order.
      await adminFormPost(
        `/admin/attributes/${id}/options/${second.id}/move-down`,
      );
      const restored = (await getAttributeWithOptions(id))!;
      expect(restored.options.map((option) => option.text)).toEqual([
        "Online",
        "In-person",
      ]);
    });

    test("returns 404 or redirects when changing a missing or invalid option", async () => {
      const attribute = await createTestAttributeWithOptions("Missing option", [
        "Only",
      ]);
      const option = attribute.options[0]!;

      expectStatus(404)(
        await adminGet(
          `/admin/attributes/${attribute.id}/options/999999/delete`,
        ),
      );
      expectStatus(404)(
        (
          await adminFormPost(
            `/admin/attributes/${attribute.id}/options/999999/edit`,
            { text: "Missing" },
          )
        ).response,
      );
      await expectFlashRedirect(
        `/admin/attributes/${attribute.id}/options/${option.id}/edit`,
        expect.any(String),
        false,
      )(
        (
          await adminFormPost(
            `/admin/attributes/${attribute.id}/options/${option.id}/edit`,
          )
        ).response,
      );
    });

    test("reorders attributes and keeps edge moves harmless", async () => {
      const first = await createTestAttributeWithOptions("First", []);
      const second = await createTestAttributeWithOptions("Second", []);

      await expectFlashRedirect(
        "/admin/attributes",
        "Attribute moved",
      )(
        (await adminFormPost(`/admin/attributes/${first.id}/move-up`)).response,
      );
      expect(
        (await getAllAttributesWithOptions()).map((item) => item.name),
      ).toEqual(["First", "Second"]);

      await expectFlashRedirect(
        "/admin/attributes",
        "Attribute moved",
      )(
        (await adminFormPost(`/admin/attributes/${second.id}/move-up`))
          .response,
      );
      expect(
        (await getAllAttributesWithOptions()).map((item) => item.name),
      ).toEqual(["Second", "First"]);
    });

    test("deletes an option after confirmation", async () => {
      const attribute = await createTestAttributeWithOptions("Season", [
        "Spring",
      ]);

      await expectHtmlResponse(
        await adminGet(
          `/admin/attributes/${attribute.id}/options/${
            attribute.options[0]!.id
          }/delete`,
        ),
        200,
        "Delete Option",
        "Spring",
      );

      const { response } = await adminFormPost(
        `/admin/attributes/${attribute.id}/options/${
          attribute.options[0]!.id
        }/delete`,
        { confirm_identifier: "Spring" },
      );
      await expectFlashRedirect(
        `/admin/attributes/${attribute.id}`,
        "Option deleted",
      )(response);
      expect((await getAttributeWithOptions(attribute.id))?.options).toEqual(
        [],
      );
    });

    test("deletes an attribute after confirmation", async () => {
      const attribute = await createTestAttributeWithOptions("Audience", [
        "Adults",
      ]);

      await expectHtmlResponse(
        await adminGet(`/admin/attributes/${attribute.id}/delete`),
        200,
        "Delete Attribute",
        "Audience",
      );

      const { response } = await adminFormPost(
        `/admin/attributes/${attribute.id}/delete`,
        { confirm_identifier: "Audience" },
      );
      await expectFlashRedirect(
        "/admin/attributes",
        "Attribute deleted",
      )(response);
      expect(await getAttributeWithOptions(attribute.id)).toBeNull();
    });
  });

  describe("listing attributes tab", () => {
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

    test("shows the empty state when no attributes exist", async () => {
      const listing = await createTestListing({ name: "No attributes" });

      await expectHtmlResponse(
        await adminGet(`/admin/listing/${listing.id}/attributes`),
        200,
        "Attributes for No attributes",
        "No attributes created yet.",
      );
    });

    test("shows available options and checked selections", async () => {
      const listing = await createTestListing({ name: "Tagged listing" });
      const attribute = await createTestAttributeWithOptions("Difficulty", [
        "Easy",
        "Hard",
      ]);
      await setListingAttributeOptions(listing.id, [attribute.options[1]!.id]);

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
