import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  CreateImageBodySchema,
  ImageRowSchema,
  UpdateImageBodySchema,
} from "#shared/admin-api-images.ts";

/** The sentences that a refused input gives, in order. */
const refusals = (schema: v.GenericSchema, input: unknown): string[] => {
  const parsed = v.safeParse(schema, input);
  return parsed.success ? [] : parsed.issues.map((issue) => issue.message);
};

const ROW = {
  alt_text: "A cat",
  id: 7,
  items: [{ item_id: 3, item_type: "listing" }],
  name: "cat.webp",
  thumb_url: "/thumb/cat.webp",
  url: "/img/cat.webp",
};

const LINK_REFUSAL =
  "Each link needs an item_type of listing, group, news, page, and a whole item_id";

describe("ImageRowSchema", () => {
  test("keeps an image row as it is, with the fields that the server adds", () => {
    expect(v.parse(ImageRowSchema, { ...ROW, extra: true })).toEqual({
      ...ROW,
      extra: true,
    });
  });

  for (const field of ["alt_text", "name", "thumb_url", "url"] as const) {
    test(`refuses a row with no ${field}`, () => {
      const { [field]: _left, ...row } = ROW;

      expect(v.safeParse(ImageRowSchema, row).success).toBe(false);
    });
  }

  test("says one sentence for a link that has a bad type or a bad id value", () => {
    for (const items of [
      [{ item_id: 3, item_type: "other" }],
      [{ item_id: "3", item_type: "listing" }],
    ]) {
      expect(refusals(ImageRowSchema, { ...ROW, items })).toEqual([
        LINK_REFUSAL,
      ]);
    }
  });
});

describe("CreateImageBodySchema", () => {
  const BODY = {
    alt_text: "A cat",
    content_type: "image/webp",
    file: "AAAA",
    name: "cat.webp",
  };

  test("keeps the four fields of a create", () => {
    expect(v.parse(CreateImageBodySchema, BODY)).toEqual(BODY);
  });

  for (const [field, message] of [
    ["name", "Image name is required"],
    ["content_type", "content_type is required"],
    ["file", "file is required"],
  ] as const) {
    test(`answers "${message}" when ${field} is empty`, () => {
      expect(refusals(CreateImageBodySchema, { ...BODY, [field]: "" })).toEqual(
        [message],
      );
    });
  }

  test("names the field that is not text", () => {
    expect(refusals(CreateImageBodySchema, { ...BODY, name: 5 })).toEqual([
      "name must be a string",
    ]);
    expect(refusals(CreateImageBodySchema, { ...BODY, alt_text: 5 })).toEqual([
      "alt_text must be a string",
    ]);
  });

  test("leaves alt text out when it is not sent", () => {
    const { alt_text: _alt, ...body } = BODY;

    expect(v.parse(CreateImageBodySchema, body)).toEqual(body);
  });
});

describe("UpdateImageBodySchema", () => {
  test("takes any one field alone, and no field at all", () => {
    expect(v.parse(UpdateImageBodySchema, {})).toEqual({});
    expect(v.parse(UpdateImageBodySchema, { alt_text: "New" })).toEqual({
      alt_text: "New",
    });
    expect(v.parse(UpdateImageBodySchema, { name: "new.webp" })).toEqual({
      name: "new.webp",
    });
  });

  test("replaces the links with the items that it is sent", () => {
    expect(
      v.parse(UpdateImageBodySchema, {
        items: [{ item_id: 3, item_type: "page" }],
      }),
    ).toEqual({ items: [{ item_id: 3, item_type: "page" }] });
  });

  test("names the field that is not text", () => {
    expect(refusals(UpdateImageBodySchema, { name: 5 })).toEqual([
      "name must be a string",
    ]);
    expect(refusals(UpdateImageBodySchema, { alt_text: 5 })).toEqual([
      "alt_text must be a string",
    ]);
  });

  test("answers that items must be an array", () => {
    expect(refusals(UpdateImageBodySchema, { items: "listing" })).toEqual([
      "items must be an array",
    ]);
  });
});
