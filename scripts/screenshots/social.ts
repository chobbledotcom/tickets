import type { Rgb } from "./color.ts";

export interface SocialTargetSize {
  height: number;
  width: number;
}

export const SOCIAL_TARGET_SIZES = {
  facebook: { height: 630, width: 1200 },
  "instagram-landscape": { height: 566, width: 1080 },
  "instagram-portrait": { height: 1350, width: 1080 },
  "instagram-square": { height: 1080, width: 1080 },
} as const satisfies Record<string, SocialTargetSize>;

export type SocialTargetName = keyof typeof SOCIAL_TARGET_SIZES;

export const SOCIAL_TARGET_NAMES = Object.keys(
  SOCIAL_TARGET_SIZES,
) as SocialTargetName[];

const noPadding = { bottom: 0, left: 0, right: 0, top: 0 };

export interface SocialExtensionPlan {
  extend: { bottom: number; left: number; right: number; top: number };
  finalHeight: number;
  finalWidth: number;
}

export const planSocialExtension = (
  source: { height: number; width: number },
  target: SocialTargetSize,
): SocialExtensionPlan => {
  const sourceRatio = source.width / source.height;
  const targetRatio = target.width / target.height;
  if (sourceRatio === targetRatio) {
    return {
      extend: noPadding,
      finalHeight: source.height,
      finalWidth: source.width,
    };
  }
  if (sourceRatio < targetRatio) {
    const finalWidth = Math.round(source.height * targetRatio);
    return {
      extend: { ...noPadding, left: finalWidth - source.width },
      finalHeight: source.height,
      finalWidth,
    };
  }
  const finalHeight = Math.round(source.width / targetRatio);
  return {
    extend: { ...noPadding, bottom: finalHeight - source.height },
    finalHeight,
    finalWidth: source.width,
  };
};

export const applySocialTarget = async (
  inputPath: string,
  outputPath: string,
  target: SocialTargetName,
  background: Rgb,
): Promise<void> => {
  const { default: sharp } = await import("sharp");
  const size = SOCIAL_TARGET_SIZES[target];
  const image = sharp(inputPath);
  const meta = await image.metadata();
  const plan = planSocialExtension(
    { height: meta.height!, width: meta.width! },
    size,
  );
  const extended = await image
    .extend({ background, ...plan.extend })
    .png()
    .toBuffer();
  const scaled =
    plan.finalWidth > size.width
      ? sharp(extended).resize(size.width, size.height, { fit: "fill" })
      : sharp(extended);
  await scaled.png().toFile(outputPath);
};
