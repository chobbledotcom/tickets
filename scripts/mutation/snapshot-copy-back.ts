/**
 * Bringing a snapshot run's file edits back to the live checkout.
 *
 * A run works inside a copy of the checkout, so anything it means to keep —
 * such as a pruned equivalent-mutant list — has to be carried back out before
 * the copy is deleted.
 */

import { join } from "@std/path";
import { errorMessage } from "#shared/error-message.ts";

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
 * Copy one file out of the snapshot, and say whether it moved. A file someone
 * else edited during the run stops the copy: the run's version was built from
 * the older text, so writing it would undo their edit.
 */
const copyOneBack = async (
  root: string,
  workRoot: string,
  { before, file }: CopyBackFile,
): Promise<boolean> => {
  if ((await Deno.readTextFile(join(root, file))) !== before) {
    throw new Error(
      `${file} changed while the isolated run was going, so its result was left behind. Re-run it on an unchanged checkout.`,
    );
  }
  const after = await Deno.readTextFile(join(workRoot, file));
  if (after === before) return false;
  await Deno.writeTextFile(join(root, file), after);
  return true;
};

/** Bring every kept file back, and report a failure as an exit code. */
export const bringFilesBack = async (
  root: string,
  workRoot: string,
  files: CopyBackFile[],
): Promise<number> => {
  try {
    for (const entry of files) {
      if (await copyOneBack(root, workRoot, entry)) {
        console.log(`Updated ${entry.file}`);
      }
    }
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
};
