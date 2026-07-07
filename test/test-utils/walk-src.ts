/** Recursively list files under `dir` whose path ends with one of `exts`.
 * Shared by the source-scanning invariant tests (i18n coverage, guide anchor
 * links) so the directory-walk logic lives in exactly one place. */
export const walkSourceFiles = (dir: string, exts: string[]): string[] => {
  const out: string[] = [];
  const recurse = (d: string): void => {
    for (const e of Deno.readDirSync(d)) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) recurse(p);
      else if (exts.some((x) => p.endsWith(x))) out.push(p);
    }
  };
  recurse(dir);
  return out;
};
