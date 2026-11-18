/**
 * The image picker's shared contract (`src/shared/images/picker.ts`): the
 * options reply that the server writes and the browser reads, and the names
 * that the server's template and the browser's picker both use.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import * as v from "valibot";
import {
  IMAGE_PICKER_ID,
  ImageOptionsReplySchema,
  LAZY_THUMBNAIL_FROM,
  PICKER_NOTES,
} from "#shared/images/picker.ts";

const ALPHA = {
  full: "/image/alpha.webp",
  id: 2,
  name: "Alpha",
  thumb: "/image/alpha-thumb.webp",
};

describe("the image picker contract", () => {
  test("reads the options reply into the images it offers", () => {
    expect(v.parse(ImageOptionsReplySchema, { images: [ALPHA] })).toEqual({
      images: [ALPHA],
    });
  });

  test("refuses an image without its full address", () => {
    const { full: _full, ...withoutFull } = ALPHA;

    expect(() =>
      v.parse(ImageOptionsReplySchema, { images: [withoutFull] }),
    ).toThrow(v.ValiError);
  });

  test("names the template with an id that a selector can reach", () => {
    // The browser finds the template with `template#<id>`.
    expect(IMAGE_PICKER_ID).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  test("names each note once, as a word a data attribute can carry", () => {
    expect(PICKER_NOTES.filter((note) => !/^[a-zA-Z]+$/.test(note))).toEqual(
      [],
    );
    expect(new Set(PICKER_NOTES).size).toBe(PICKER_NOTES.length);
  });

  test("loads the first nine thumbnails at once", () => {
    expect(LAZY_THUMBNAIL_FROM).toBe(9);
  });
});
