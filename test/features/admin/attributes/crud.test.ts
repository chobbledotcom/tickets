import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  attributeNameForm,
  attributeOptionForm,
} from "#routes/admin/attributes.ts";
import { getAllActivityLog } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectRedirect,
  expectStatus,
  inputNamed,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttributeWithOptions } from "#test-utils/db-helpers/attributes.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

/** Create an attribute through the real POST and return its new id. */
const createAttribute = async (name: string): Promise<number> => {
  const { response } = await adminFormPost("/admin/attributes", { name });
  const location = expectRedirect(response, /^\/admin\/attributes\/\d+/);
  return Number(new URL(location, "http://localhost").pathname.split("/")[3]);
};

describeWithEnv(
  "server (admin attribute create and edit)",
  { db: true },
  () => {
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
        expect(inputNamed(html, "text")).toContain(
          'placeholder="e.g. Beginner"',
        );
      });
    });

    describe("POST /admin/attributes", () => {
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
        await expectHtmlResponse(await adminGet(location), 200, "Terrain");
        const messages = (await getAllActivityLog()).map(
          (entry) => entry.message,
        );
        expect(messages).toContain("Attribute 'Terrain' created");
      });

      test("a new attribute joins the order, so it can be moved", async () => {
        await createAttribute("Alpha");
        const betaId = await createAttribute("Beta");

        const before = await expectHtmlResponse(
          await adminGet("/admin/attributes"),
          200,
        );
        expect(before.indexOf(">Alpha<")).toBeGreaterThanOrEqual(0);
        expect(before.indexOf(">Alpha<")).toBeLessThan(
          before.indexOf(">Beta<"),
        );

        await adminFormPost(`/admin/attributes/${betaId}/move-up`, {});

        const after = await expectHtmlResponse(
          await adminGet("/admin/attributes"),
          200,
        );
        expect(after.indexOf(">Beta<")).toBeGreaterThanOrEqual(0);
        expect(after.indexOf(">Beta<")).toBeLessThan(after.indexOf(">Alpha<"));
      });

      test("an empty name is refused back to the attributes page", async () => {
        const { response } = await adminFormPost("/admin/attributes", {
          name: "",
        });

        await expectFlashRedirect(
          "/admin/attributes",
          "Attribute name is required",
          false,
        )(response);
      });
    });

    describe("POST /admin/attributes/:id/options", () => {
      test("adding an option stores it, logs it, and says so", async () => {
        const attribute = await createTestAttributeWithOptions(
          "Difficulty",
          [],
        );

        const { response } = await adminFormPost(
          `/admin/attributes/${attribute.id}/options`,
          { text: "Easy" },
        );

        await expectFlashRedirect(
          `/admin/attributes/${attribute.id}`,
          "Option added",
          true,
        )(response);
        await expectHtmlResponse(
          await adminGet(`/admin/attributes/${attribute.id}`),
          200,
          "Easy",
        );
        const messages = (await getAllActivityLog()).map(
          (entry) => entry.message,
        );
        expect(messages).toContain(
          "Attribute option 'Easy' added to Difficulty",
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
          expect.stringContaining("Attribute name does not match"),
          false,
        )(response);
      });

      test("deleting removes the attribute, logs it, and says so", async () => {
        const attribute = await createTestAttributeWithOptions("Doomed", [
          "Only",
        ]);

        const { response } = await adminFormPost(
          `/admin/attributes/${attribute.id}/delete`,
          { confirm_identifier: "Doomed" },
        );

        await expectFlashRedirect(
          "/admin/attributes",
          "Attribute deleted",
          true,
        )(response);
        expectStatus(404)(await adminGet(`/admin/attributes/${attribute.id}`));
        const messages = (await getAllActivityLog()).map(
          (entry) => entry.message,
        );
        expect(messages).toContain("Attribute 'Doomed' deleted");
      });
    });

    describe("POST /admin/attributes/:id/options/:optionId/delete", () => {
      test("deleting an option needs the exact option text", async () => {
        const attribute = await createTestAttributeWithOptions("Difficulty", [
          "Easy",
        ]);
        const easy = attribute.options[0]!;

        const { response } = await adminFormPost(
          `/admin/attributes/${attribute.id}/options/${easy.id}/delete`,
          { confirm_identifier: "Nope" },
        );

        await expectFlashRedirect(
          `/admin/attributes/${attribute.id}/options/${easy.id}/delete`,
          "Option text does not match. Please type the exact option text to confirm deletion.",
          false,
        )(response);
      });

      test("deleting an option removes it, logs it, and says so", async () => {
        const attribute = await createTestAttributeWithOptions("Difficulty", [
          "Easy",
        ]);
        const easy = attribute.options[0]!;

        const { response } = await adminFormPost(
          `/admin/attributes/${attribute.id}/options/${easy.id}/delete`,
          { confirm_identifier: "Easy" },
        );

        await expectFlashRedirect(
          `/admin/attributes/${attribute.id}`,
          "Option deleted",
          true,
        )(response);
        const html = await expectHtmlResponse(
          await adminGet(`/admin/attributes/${attribute.id}`),
          200,
        );
        expect(html).not.toContain(">Easy<");
        const messages = (await getAllActivityLog()).map(
          (entry) => entry.message,
        );
        expect(messages).toContain(
          "Attribute option 'Easy' deleted from Difficulty",
        );
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
        const html = await expectHtmlResponse(
          await adminGet(`/admin/attributes/${attribute.id}`),
          200,
          "New name",
        );
        expect(html).not.toContain("Old name");
        const messages = (await getAllActivityLog()).map(
          (entry) => entry.message,
        );
        expect(messages).toContain("Attribute 'New name' updated");
      });
    });
  },
);
