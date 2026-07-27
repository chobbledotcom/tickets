import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import { trimElementPng } from "#scripts/screenshots/image.ts";
import { whitePngWithBlackBox } from "#test/scripts/screenshots-fixture.ts";

describe("screenshot element image", () => {
  test("trims the element and adds 32 pixel padding", async () => {
    const result = await trimElementPng(await whitePngWithBlackBox(), {
      b: 255,
      g: 255,
      r: 255,
    });

    expect(await sharp(result).metadata()).toEqual(
      expect.objectContaining({ format: "png", height: 84, width: 94 }),
    );
  });

  test("rejects an image whose background was not trimmed", async () => {
    const source = await sharp({
      create: {
        background: "black",
        channels: 3,
        height: 10,
        width: 10,
      },
    })
      .png()
      .toBuffer();

    await expect(
      trimElementPng(source, { b: 255, g: 255, r: 255 }),
    ).rejects.toThrow("has no visible content");
  });
});
