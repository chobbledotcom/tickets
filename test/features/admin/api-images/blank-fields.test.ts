import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getImageById } from "#db/images.ts";
import { t } from "#i18n";
import { makeImage, putImage } from "#test-utils/admin-images.ts";
import { assertJson, expectApiError } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv(
  "Admin API - Image update with blank fields",
  { db: true, storage: "cdn" },
  () => {
    test("an empty name is refused, not swapped for the stored one", async () => {
      const image = await makeImage("Named");
      await expectApiError(
        putImage(image.id, { name: "" }),
        400,
        t("images.error.name_required"),
      );
      expect((await getImageById(image.id))?.name).toBe("Named");
    });

    test("an empty alt text clears the stored alt text", async () => {
      const image = await makeImage("Described");
      await assertJson(putImage(image.id, { alt_text: "" }), 200, (body) => {
        expect(body.image.alt_text).toBe("");
      });
      expect((await getImageById(image.id))?.alt_text).toBe("");
    });
  },
);
