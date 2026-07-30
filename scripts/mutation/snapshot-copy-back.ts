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

/** Stop the copy when someone else edited the file during the run: the run's
 * version was built from the older text, so writing it would undo their edit. */
const assertUnchanged = async (
  root: string,
  { before, file }: CopyBackFile,
): Promise<void> => {
  if ((await Deno.readTextFile(join(root, file))) !== before) {
    throw new Error(
      `${file} changed while the isolated run was going, so its result was left behind. Re-run it on an unchanged checkout.`,
    );
  }
};

/** One file this run wrote back, with the text before and after the write. */
export interface WrittenFile {
  after: string;
  before: string;
  file: string;
}

/** Undo this run's own writes after a failure. A file that no longer holds
 * what this run wrote was edited again meanwhile — that edit stays. Every
 * file gets its restore attempt even when an earlier one fails, so one bad
 * path cannot leave the rest of the run's writes applied. */
export const putBackOwnWrites = async (
  root: string,
  written: WrittenFile[],
): Promise<void> => {
  const problems: string[] = [];
  for (const { after, before, file } of written) {
    try {
      if ((await Deno.readTextFile(join(root, file))) === after) {
        await Deno.writeTextFile(join(root, file), before);
        console.log(`Put back ${file}`);
      }
    } catch (error) {
      problems.push(`${file}: ${errorMessage(error)}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Could not put back every file:\n${problems.join("\n")}`);
  }
};

/** Bring every kept file back, and report a failure as an exit code. */
export const bringFilesBack = async (
  root: string,
  workRoot: string,
  files: CopyBackFile[],
): Promise<number> => {
  try {
    // Check every file before writing any: one changed file stops the whole
    // copy up front, so a multi-file result is never left partly applied.
    for (const entry of files) {
      await assertUnchanged(root, entry);
    }
    const written: WrittenFile[] = [];
    try {
      for (const entry of files) {
        // Checked again at the moment of writing: an edit that lands between
        // the preflight and this file's turn must still stop the overwrite.
        await assertUnchanged(root, entry);
        const after = await Deno.readTextFile(join(workRoot, entry.file));
        if (after === entry.before) continue;
        await Deno.writeTextFile(join(root, entry.file), after);
        written.push({ after, before: entry.before, file: entry.file });
        console.log(`Updated ${entry.file}`);
      }
    } catch (error) {
      // A failure part-way through must not leave a half-applied result: put
      // back what was already written, then report the original failure. An
      // undo problem is reported too, but never hides what stopped the copy.
      try {
        await putBackOwnWrites(root, written);
      } catch (undoProblem) {
        console.error(errorMessage(undoProblem));
      }
      throw error;
    }
    return 0;
  } catch (error) {
    console.error(errorMessage(error));
    return 1;
  }
};
