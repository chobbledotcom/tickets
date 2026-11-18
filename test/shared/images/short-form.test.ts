/**
 * The short-form image address (`src/shared/images/short-form.ts`): the
 * `img#7` form that the markdown editor writes and the stored markdown keeps.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  shortFormImageAddress,
  shortFormImageId,
} from "#shared/images/short-form.ts";

describe("the short-form image address", () => {
  test("names one library image by its id", () => {
    expect(shortFormImageAddress(7)).toBe("img#7");
  });

  test("reads the image id back from the address", () => {
    expect(shortFormImageId("img#7")).toBe(7);
    expect(shortFormImageId(shortFormImageAddress(1234))).toBe(1234);
  });

  test("reads no id from any other address", () => {
    const others = ["/image/a.webp", "img#", "img#7x", " img#7", "IMG#7"];

    expect(others.map((href) => shortFormImageId(href))).toEqual(
      others.map(() => undefined),
    );
  });
});
