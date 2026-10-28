import { errorMessage } from "#shared/error-message.ts";

/** The filesystem calls the write goes through, so a test can inject a
 * failure into one of them. */
export interface WriteWholeDeps {
  remove(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  writeTextFile(path: string, text: string): Promise<void>;
}

/** The real calls, read at call time so a test that replaces a Deno method
 * still reaches the replacement through the default deps. */
const realDeps = (): WriteWholeDeps => ({
  remove: Deno.remove,
  rename: Deno.rename,
  writeTextFile: Deno.writeTextFile,
});

/** Take a failed write's temp file back away. The write can die before the
 * temp exists, so an absent file means there is nothing left to do; any other
 * removal failure is reported here, and the write's own error stays the one
 * the caller sees. */
const removeLeftoverTemp = async (
  temp: string,
  deps: WriteWholeDeps,
): Promise<void> => {
  try {
    await deps.remove(temp);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    console.error(`Could not remove ${temp}: ${errorMessage(error)}`);
  }
};

/** Write through a sibling temp file and rename it into place, so a write
 * that dies part-way (a full disk, a killed process) can never leave the
 * live file truncated — it holds either the old text or the new. A write
 * that fails takes its temp file back away with it, so the target directory
 * holds either the old file or the new one, and nothing else. */
export const writeWholeOrNotAtAll = async (
  path: string,
  text: string,
  deps: WriteWholeDeps = realDeps(),
): Promise<void> => {
  const temp = `${path}.writing`;
  let renamed = false;
  try {
    await deps.writeTextFile(temp, text);
    await deps.rename(temp, path);
    renamed = true;
  } finally {
    if (!renamed) await removeLeftoverTemp(temp, deps);
  }
};
