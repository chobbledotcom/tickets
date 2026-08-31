/**
 * The import map's `#` aliases, as TypeScript path mappings.
 *
 * TypeScript resolves modules through `paths`, and the repository resolves
 * them through Deno's import map. Neither reads the other, so the scan
 * translates one into the other and stays correct as aliases are added.
 */

/** Translate the `#` aliases into what a TypeScript program expects. A
 * trailing slash means a folder prefix, so both sides gain a `*`. */
export const aliasPaths = (
  imports: Record<string, string>,
): Record<string, string[]> => {
  const paths: Record<string, string[]> = {};
  for (const [alias, target] of Object.entries(imports)) {
    if (!alias.startsWith("#")) continue;
    if (alias.endsWith("/")) paths[`${alias}*`] = [`${target}*`];
    else paths[alias] = [target];
  }
  return paths;
};
