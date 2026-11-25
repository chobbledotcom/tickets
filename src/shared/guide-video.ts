// effects: pure
/** The address of one guide animation on the CDN. The base names the published
 * release, such as `https://cdn.example.com/guides/<hash>`. */

/** Reads the local preview base from the environment. The edge build replaces
 * asset-paths.ts, so production never reads this value at runtime. */
export const parseGuideCdnBase = (base: string | undefined): string | null =>
  base === undefined || base === "" ? null : base;

/** The baked base wins. A local run can supply the preview base instead. */
export const resolveGuideCdnBase = (
  baked: string | null,
  env: string | undefined,
): string | null => baked ?? parseGuideCdnBase(env);

export const guideVideoUrl = (
  base: string | null,
  slug: string,
): string | null => {
  if (base === null || base === "") return null;
  return `${base.replace(/\/+$/, "")}/${encodeURIComponent(slug)}/index.html`;
};
