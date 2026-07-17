import {
  type CleanupTask,
  failAfterCleanups,
  removeIfPresent,
} from "../cleanup.ts";
import { fileExists } from "./session.ts";

export const withGeneratedOutputRollback = async <Result>(
  outputFiles: string[],
  task: () => Promise<Result>,
  failureCleanups: () => CleanupTask[],
): Promise<Result> => {
  const generated: string[] = [];
  for (const file of outputFiles) {
    if (!(await fileExists(file))) generated.push(file);
  }
  try {
    return await task();
  } catch (error) {
    return failAfterCleanups(error, [
      ...failureCleanups(),
      ...generated.map((file) => () => removeIfPresent(file)),
    ]);
  }
};
