/**
 * Bringing a snapshot run's file edits back to the live checkout.
 *
 * A run works inside a copy of the checkout, so anything it means to keep —
 * such as a pruned equivalent-mutant list — has to be carried back out before
 * the copy is deleted.
 */

import { join } from "@std/path";

/** One file to bring back, and what it held when the run started. */
export interface CopyBackFile {
  before: string;
  file: string;
}

/** Read what each file holds now, so a later change can be spotted. */
export const readCopyBackFiles = (
  root: string,
  files: string[],
): Promise<CopyBackFile[]> =>
  Promise.all(
    files.map(async (file) => ({
      before: await Deno.readTextFile(join(root, file)),
      file,
    })),
  );

/**
 * Copy each changed file out of the snapshot, and return the ones that moved.
 * A file someone else edited during the run is left alone: the run's version
 * was built from the older text, so writing it would undo their edit.
 */
export const copyBackFiles = async (
  root: string,
  workRoot: string,
  files: CopyBackFile[],
): Promise<string[]> => {
  const copied: string[] = [];
  for (const { before, file } of files) {
    if ((await Deno.readTextFile(join(root, file))) !== before) {
      throw new Error(
        `${file} changed while the isolated run was going, so its result was left behind. Re-run it on an unchanged checkout.`,
      );
    }
    const after = await Deno.readTextFile(join(workRoot, file));
    if (after === before) continue;
    await Deno.writeTextFile(join(root, file), after);
    copied.push(file);
  }
  return copied;
};
