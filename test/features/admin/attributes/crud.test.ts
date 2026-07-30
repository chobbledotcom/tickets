import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeNameForm,
  attributeOptionForm,
} from "#routes/admin/attributes.ts";
import { setAdminFeatureEnabled } from "#shared/db/admin-features.ts";
import {
  getAllAttributesWithOptions,
  getAttributeWithOptions,
} from "#shared/db/attributes.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  expectStatus,
  inputNamed,
  testRequiresAuth,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createAttributeViaRoute,
  createTestAttributeWithOptions,
  withFailingOrderTrigger,
} from "#test-utils/db-helpers/attributes.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";
import {
  enableFeature,
  storedFeatureEnabled,
  withFeatureWriteFailure,
} from "#test-utils/settings.ts";

describeWithEnv("server (admin attribute CRUD)", { db: true }, () => {
  describe("the two attribute forms", () => {
    // The expected label and hint are written out here so a changed form
    // definition fails this test instead of moving the expectation with it.
    test("serves the name box with its label and hint", () => {
      const html = attributeNameForm.render();
      expect(html).toContain("Attribute name");
      expect(inputNamed(html, "name")).toContain(
        'placeholder="e.g. Difficulty"',
      );
    });

    test("serves the option box with its label and hint", () => {
      const html = attributeOptionForm.render();
      expect(html).toContain("Option text");
      expect(inputNamed(html, "text")).toContain('placeholder="e.g. Beginner"');
    });
  });

  describe("POST /admin/attributes", () => {
    testRequiresAuth("/admin/attributes", {
      body: { name: "Auth attribute" },
      method: "POST",
    });

    test("creating an attribute stores it, logs it, and says so", async () => {
      const { response } = await adminFormPost("/admin/attributes", {
        name: "Terrain",
      });

      const location = expectRedirect(response, /^\/admin\/attributes\/\d+/);
      await expectFlashRedirect(
        new URL(location, "http://localhost").pathname,
        "Attribute created",
        true,
      )(response);
      await expectHtmlResponse(
        await adminGet(location),
        200,
        "Terrain",
        "No options yet.",
      );
      expect(await storedFeatureEnabled("attributes")).toBe(true);
      expect(await activityMessages()).toContain("Attribute 'Terrain' created");
    });

    test("a new attribute joins the order, so it can be moved", async () => {
      const firstId = await createAttributeViaRoute("Alpha");
      const secondId = await createAttributeViaRoute("Beta");

      // Moving the top attribute up is harmless.
      await expectFlashRedirect(
        "/admin/attributes",
        "Attribute moved",
      )((await adminFormPost(`/admin/attributes/${firstId}/move-up`)).response);
      expect(
        (await getAllAttributesWithOptions()).map((item) => item.name),
      ).toEqual(["Alpha", "Beta"]);

      await adminFormPost(`/admin/attributes/${secondId}/move-up`);
      expect(
        (await getAllAttributesWithOptions()).map((item) => item.name),
      ).toEqual(["Beta", "Alpha"]);
    });

    test("an empty name is refused back to the attributes page", async () => {
      await setAdminFeatureEnabled("attributes", false);
      const { response } = await adminFormPost("/admin/attributes", {
        name: "",
      });

      await expectFlashRedirect(
        "/admin/attributes",
        "Attribute name is required",
        false,
      )(response);
      expect(await storedFeatureEnabled("attributes")).toBe(false);
    });

    test("a failed order write leaves no half-made attribute behind", async () => {
      // Fail the append's sort_order write: the insert and the append run in
      // one transaction, so the attribute must roll back with it.
      await withFailingOrderTrigger("attributes", async () => {
        await expect(
          adminFormPost("/admin/attributes", { name: "Ghost" }),
        ).rejects.toThrow("order write failed");
      });
      expect(await getAllAttributesWithOptions()).toEqual([]);
    });

    test("does not create an attribute when enabling the feature fails", async () => {
      await enableFeature("attributes");
      await expect(
        withFeatureWriteFailure(async () => {
          await adminFormPost("/admin/attributes", { name: "Hidden" });
        }),
      ).rejects.toThrow("feature enable failed");
      expect(await getAllAttributesWithOptions()).toEqual([]);
    });
  });

  describe("POST /admin/attributes/:id/edit", () => {
    test("editing saves the new name, logs it, and says so", async () => {
      const attribute = await createTestAttributeWithOptions("Old name", [
        "Only",
      ]);

      const { response } = await adminFormPost(
        `/admin/attributes/${attribute.id}/edit`,
        { name: "New name" },
      );

      await expectFlashRedirect(
        `/admin/attributes/${attribute.id}`,
        "Attribute updated",
        true,
      )(response);
      expect((await getAttributeWithOptions(attribute.id))?.name).toBe(
        "New name",
      );
      expect(await activityMessages()).toContain(
        "Attribute 'New name' updated",
      );
    });

    test("an empty name is refused back to the attribute page", async () => {
      const id = await createAttributeViaRoute("Required fields");

      await expectFlashRedirect(
        `/admin/attributes/${id}`,
        "Attribute name is required",
        false,
      )((await adminFormPost(`/admin/attributes/${id}/edit`)).response);
    });

    test("does not update an attribute when enabling the feature fails", async () => {
      const attribute = await createTestAttributeWithOptions("Before", []);
      await enableFeature("attributes");
      await expect(
        withFeatureWriteFailure(async () => {
          await adminFormPost(`/admin/attributes/${attribute.id}/edit`, {
            name: "After",
          });
        }),
      ).rejects.toThrow("feature enable failed");
      expect((await getAttributeWithOptions(attribute.id))?.name).toBe(
        "Before",
      );
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
  });

  describe("POST /admin/attributes/:id/delete", () => {
    test("deleting needs the exact attribute name", async () => {
      const attribute = await createTestAttributeWithOptions("Doomed", [
        "Only",
      ]);

      const { response } = await adminFormPost(
        `/admin/attributes/${attribute.id}/delete`,
        { confirm_identifier: "Wrong" },
      );

      await expectFlashRedirect(
        `/admin/attributes/${attribute.id}/delete`,
        "Attribute name does not match. Please type the exact attribute name to confirm deletion.",
        false,
      )(response);
      expect(await getAttributeWithOptions(attribute.id)).not.toBeNull();
    });

    test("deleting removes the attribute, logs it, and says so", async () => {
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
        true,
      )(response);
      expect(await getAttributeWithOptions(attribute.id)).toBeNull();
      expectStatus(404)(await adminGet(`/admin/attributes/${attribute.id}`));
      expect(await activityMessages()).toContain(
        "Attribute 'Audience' deleted",
      );
    });
  });
});
