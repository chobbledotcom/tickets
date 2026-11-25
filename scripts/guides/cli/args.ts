/** Reject a session replay that asks for more than one guide. */
export const requireOneGuide = (
  slugs: readonly string[],
  from: string | undefined,
): void => {
  if (from !== undefined && slugs.length !== 1) {
    throw new Error("--from takes exactly one guide");
  }
};

/** Resolve the guide slugs a command asks for. `all` means every guide. */
export const guideSlugs = (
  requested: readonly (string | number)[],
  fallback: readonly string[],
  from: string | undefined,
): string[] => {
  const slugs =
    requested.length === 0 || requested[0] === "all"
      ? [...fallback]
      : requested.map(String);
  requireOneGuide(slugs, from);
  return slugs;
};
