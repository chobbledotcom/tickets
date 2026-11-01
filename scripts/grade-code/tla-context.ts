/** Only declared source files can become paid-review context. */
import { assertNoSymlink } from "#scripts/tla/files.ts";
import { isReviewSourcePath } from "#scripts/verify-models/spec.ts";

/** Require a canonical repository-relative source path, not data or secrets. */
export const approvedContextPath = (file: string): string => {
  if (!isReviewSourcePath(file)) {
    throw new Error(`Forbidden TLA review context: ${file}`);
  }
  return file;
};

/** Reject links in every component, using the shared source-boundary policy. */
export const readContextSource = async (file: string): Promise<string> => {
  approvedContextPath(file);
  await assertNoSymlink(file);
  const info = await Deno.lstat(file);
  if (!info.isFile) throw new Error(`Not a source file: ${file}`);
  return Deno.readTextFile(file);
};
