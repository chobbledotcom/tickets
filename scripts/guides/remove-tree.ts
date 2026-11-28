/** Remove a directory tree, accepting that another cleanup already removed it. */
import { removeIfPresent } from "#scripts/cleanup.ts";

export const removeTree = (path: string): Promise<void> =>
  removeIfPresent(path, (target) => Deno.remove(target, { recursive: true }));
