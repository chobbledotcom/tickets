import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import sharp from "sharp";
import {
  applySocialTarget,
  planSocialExtension,
  SOCIAL_TARGET_NAMES,
  SOCIAL_TARGET_SIZES,
} from "#scripts/screenshots/social.ts";

describe("social target sizes", () => {
  it("defines the recommended share sizes for facebook and instagram", () => {
    expect(SOCIAL_TARGET_SIZES).toEqual({
      facebook: { height: 630, width: 1200 },
      "instagram-landscape": { height: 566, width: 1080 },
      "instagram-portrait": { height: 1350, width: 1080 },
      "instagram-square": { height: 1080, width: 1080 },
    });
  });

  it("lists every target name", () => {
    expect(SOCIAL_TARGET_NAMES).toEqual([
      "facebook",
      "instagram-landscape",
      "instagram-portrait",
      "instagram-square",
    ]);
  });
});

describe("planSocialExtension", () => {
  it("extends the left edge when the source is taller than the target ratio", () => {
    const plan = planSocialExtension(
      { height: 400, width: 200 },
      SOCIAL_TARGET_SIZES.facebook,
    );
    expect(plan.extend).toEqual({ bottom: 0, left: 562, right: 0, top: 0 });
    expect(plan.finalHeight).toBe(400);
    expect(plan.finalWidth).toBe(762);
  });

  it("extends the bottom edge when the source is wider than the target ratio", () => {
    const plan = planSocialExtension(
      { height: 100, width: 400 },
      SOCIAL_TARGET_SIZES["instagram-portrait"],
    );
    expect(plan.extend).toEqual({ bottom: 400, left: 0, right: 0, top: 0 });
    expect(plan.finalHeight).toBe(500);
    expect(plan.finalWidth).toBe(400);
  });

  it("leaves the image untouched when the source already matches the target ratio", () => {
    const plan = planSocialExtension(
      { height: 630, width: 1200 },
      SOCIAL_TARGET_SIZES.facebook,
    );
    expect(plan.extend).toEqual({ bottom: 0, left: 0, right: 0, top: 0 });
    expect(plan.finalHeight).toBe(630);
    expect(plan.finalWidth).toBe(1200);
  });
});

describe("applySocialTarget", () => {
  const background = { b: 0, g: 0, r: 255 };

  const makeSourcePng = async (
    path: string,
    height: number,
    width: number,
  ): Promise<void> => {
    await sharp({
      create: {
        background: { alpha: 1, b: 255, g: 255, r: 255 },
        channels: 4,
        height,
        width,
      },
    } as never)
      .png()
      .toFile(path);
  };

  const dimensionsOf = async (
    path: string,
  ): Promise<{ height: number; width: number }> => {
    const meta = await sharp(path).metadata();
    if (!meta.width || !meta.height) {
      throw new Error(`Could not read image: ${path}`);
    }
    return { height: meta.height, width: meta.width };
  };

  const pixelAt = async (
    path: string,
    x: number,
    y: number,
  ): Promise<{ b: number; g: number; r: number }> => {
    const { data, info } = await sharp(path)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const offset = (y * info.width + x) * info.channels;
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    if (r === undefined || g === undefined || b === undefined) {
      throw new Error(`Pixel at (${x}, ${y}) is out of bounds`);
    }
    return { b, g, r };
  };

  for (const target of SOCIAL_TARGET_NAMES) {
    it(`extends and downscales a mobile screenshot to the ${target} size`, async () => {
      const tmpDir = await Deno.makeTempDir({
        prefix: `screenshots-social-${target}-`,
      });
      try {
        const sourcePath = join(tmpDir, "source.png");
        const outputPath = join(tmpDir, "variant.png");
        await makeSourcePng(sourcePath, 1688, 780);
        await applySocialTarget(sourcePath, outputPath, target, background);
        expect(await dimensionsOf(outputPath)).toEqual(
          SOCIAL_TARGET_SIZES[target],
        );
      } finally {
        await Deno.remove(tmpDir, { recursive: true });
      }
    });
  }

  it("keeps a source smaller than the target instead of upscaling", async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "screenshots-social-small-",
    });
    try {
      const sourcePath = join(tmpDir, "source.png");
      const outputPath = join(tmpDir, "variant.png");
      await makeSourcePng(sourcePath, 400, 200);
      await applySocialTarget(sourcePath, outputPath, "facebook", background);
      expect(await dimensionsOf(outputPath)).toEqual({
        height: 400,
        width: 762,
      });
      expect(await pixelAt(outputPath, 0, 200)).toEqual({
        b: 0,
        g: 0,
        r: 255,
      });
      expect(await pixelAt(outputPath, 761, 200)).toEqual({
        b: 255,
        g: 255,
        r: 255,
      });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  });

  it("copies a source that already matches the target size", async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "screenshots-social-exact-",
    });
    try {
      const sourcePath = join(tmpDir, "source.png");
      const outputPath = join(tmpDir, "variant.png");
      await makeSourcePng(sourcePath, 630, 1200);
      await applySocialTarget(sourcePath, outputPath, "facebook", background);
      expect(await dimensionsOf(outputPath)).toEqual({
        height: 630,
        width: 1200,
      });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  });

  it("extends the bottom edge when the source is wider than the target ratio", async () => {
    const tmpDir = await Deno.makeTempDir({
      prefix: "screenshots-social-bottom-",
    });
    try {
      const sourcePath = join(tmpDir, "source.png");
      const outputPath = join(tmpDir, "variant.png");
      await makeSourcePng(sourcePath, 100, 400);
      await applySocialTarget(
        sourcePath,
        outputPath,
        "instagram-portrait",
        background,
      );
      expect(await dimensionsOf(outputPath)).toEqual({
        height: 500,
        width: 400,
      });
      expect(await pixelAt(outputPath, 200, 0)).toEqual({
        b: 255,
        g: 255,
        r: 255,
      });
      expect(await pixelAt(outputPath, 200, 499)).toEqual({
        b: 0,
        g: 0,
        r: 255,
      });
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  });
});
