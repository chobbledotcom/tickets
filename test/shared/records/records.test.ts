/**
 * Direct tests of the record declarations whose write commands their admin
 * routes own: the rule and the race answers the route suites cannot set up.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { deleteImageRecord } from "#db/images.ts";
import { t } from "#i18n";
import { imageRecord } from "#shared/records/images.ts";
import { newsRecord } from "#shared/records/news.ts";
import { nonEmptyString } from "#shared/validation/string.ts";
import { makeImage } from "#test-utils/admin-images.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestNewsPost } from "#test-utils/db-helpers/misc.ts";
import { beforeNextTransaction } from "#test-utils/record-queries.ts";

const imageInput = {
  altText: "A cat",
  filename: nonEmptyString("cat.webp"),
  filenameThumb: nonEmptyString("cat-thumb.webp"),
  name: "Cat",
};

describe("the image record's rule", () => {
  test("trims the name and alt text it stores", () => {
    expect(
      imageRecord.rule(
        {
          ...imageInput,
          altText: "  A cat  ",
          name: "  Cat photo  ",
        },
        null,
      ),
    ).toEqual({
      ok: true,
      value: { ...imageInput, altText: "A cat", name: "Cat photo" },
    });
  });

  test("refuses a name with nothing in it", () => {
    expect(imageRecord.rule({ ...imageInput, name: "   " }, null)).toEqual({
      error: t("images.error.name_required"),
      ok: false,
    });
  });
});

describeWithEnv("the image record's update", { db: true }, () => {
  test("answers not-found when the image is deleted before the write", async () => {
    const image = await makeImage("Vanishing");
    const restore = beforeNextTransaction(() => deleteImageRecord(image.id));
    try {
      expect(
        await imageRecord.update(image.id, {
          filename: image.filename,
          filenameThumb: image.filename_thumb,
          name: "Gone",
        }),
      ).toEqual({ kind: "not-found" });
    } finally {
      restore();
    }
  });
});

describeWithEnv("the news record's update", { db: true }, () => {
  test("refuses an update that does not carry the stored slug", async () => {
    const post = await createTestNewsPost("Slug guard");

    await expect(
      newsRecord.update(post.id, {
        content: "",
        metaDescription: "",
        metaTitle: "",
        name: "Renamed",
        snippet: "",
      }),
    ).rejects.toThrow("A news post update must carry its slug");
  });
});
