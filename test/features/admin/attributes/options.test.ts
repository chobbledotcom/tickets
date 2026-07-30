import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttributeWithOptions } from "#shared/db/attributes.ts";
import { activityMessages } from "#test-utils/activity-log.ts";
import {
  expectFlashRedirect,
  expectHtmlResponse,
  expectStatus,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createAttributeViaRoute,
  createTestAttributeWithOptions,
} from "#test-utils/db-helpers/attributes.ts";
import { withFailingOrderTrigger } from "#test-utils/db-helpers/failing-order.ts";
import { adminFormPost, adminGet } from "#test-utils/session.ts";

/** Ask the delete route to remove Difficulty's only option, "Easy". */
const postEasyOptionDelete = async (
  confirmIdentifier: string,
): Promise<{ attributeId: number; optionId: number; response: Response }> => {
  const attribute = await createTestAttributeWithOptions("Difficulty", [
    "Easy",
  ]);
  const optionId = attribute.options[0]!.id;
  const { response } = await adminFormPost(
    `/admin/attributes/${attribute.id}/options/${optionId}/delete`,
    { confirm_identifier: confirmIdentifier },
  );
  return { attributeId: attribute.id, optionId, response };
};

describeWithEnv("server (admin attribute options)", { db: true }, () => {
  describe("POST /admin/attributes/:id/options", () => {
    test("adding an option stores it, logs it, and says so", async () => {
      const attribute = await createTestAttributeWithOptions("Difficulty", []);

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
      expect(await activityMessages()).toContain(
        "Attribute option 'Easy' added to Difficulty",
      );
    });

    test("a failed order write leaves no half-made option behind", async () => {
      // Fail the append's sort_order write: the insert and the append run in
      // one transaction, so the option must roll back with it instead of
      // surviving with its placeholder order.
      const attribute = await createTestAttributeWithOptions("Fragile", []);
      await withFailingOrderTrigger("attribute_options", async () => {
        await expect(
          adminFormPost(`/admin/attributes/${attribute.id}/options`, {
            text: "Ghost",
          }),
        ).rejects.toThrow("order write failed");
      });
      expect((await getAttributeWithOptions(attribute.id))?.options).toEqual(
        [],
      );
    });

    test("an empty option is refused back to the attribute page", async () => {
      const id = await createAttributeViaRoute("Fields");

      await expectFlashRedirect(
        `/admin/attributes/${id}`,
        "Option text is required",
        false,
      )((await adminFormPost(`/admin/attributes/${id}/options`)).response);
      expect((await getAttributeWithOptions(id))?.options).toEqual([]);
    });
  });

  describe("POST /admin/attributes/:id/options/:optionId/edit and moves", () => {
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
      expect(await activityMessages()).toContain(
        "Attribute option 'In-person' updated in Format",
      );
      const moved = await adminFormPost(
        `/admin/attributes/${id}/options/${second.id}/move-up`,
      );
      await expectFlashRedirect(
        `/admin/attributes/${id}`,
        "Option moved",
        true,
      )(moved.response);

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
        "Option text is required",
        false,
      )(
        (
          await adminFormPost(
            `/admin/attributes/${attribute.id}/options/${option.id}/edit`,
          )
        ).response,
      );
      expect(
        (await getAttributeWithOptions(attribute.id))?.options.map(
          (row) => row.text,
        ),
      ).toEqual(["Only"]);
    });
  });

  describe("POST /admin/attributes/:id/options/:optionId/delete", () => {
    test("deleting an option needs the exact option text", async () => {
      const { attributeId, optionId, response } =
        await postEasyOptionDelete("Nope");

      await expectFlashRedirect(
        `/admin/attributes/${attributeId}/options/${optionId}/delete`,
        "Option text does not match. Please type the exact option text to confirm deletion.",
        false,
      )(response);
      expect(
        (await getAttributeWithOptions(attributeId))?.options,
      ).toHaveLength(1);
    });

    test("deleting an option removes it, logs it, and says so", async () => {
      const { attributeId, response } = await postEasyOptionDelete("Easy");

      await expectFlashRedirect(
        `/admin/attributes/${attributeId}`,
        "Option deleted",
        true,
      )(response);
      expect((await getAttributeWithOptions(attributeId))?.options).toEqual([]);
      expect(await activityMessages()).toContain(
        "Attribute option 'Easy' deleted from Difficulty",
      );
    });

    test("shows the confirmation page before deleting", async () => {
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
        "Delete option",
        "Spring",
      );
    });
  });
});
