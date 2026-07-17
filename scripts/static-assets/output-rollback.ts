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
  const originals = await Promise.all(
    outputFiles.map(async (file) => ({
      contents: (await fileExists(file)) ? await Deno.readFile(file) : null,
      file,
    })),
  );
  try {
    return await task();
  } catch (error) {
    return failAfterCleanups(error, [
      ...failureCleanups(),
      ...originals.map(({ contents, file }) =>
        contents === null
          ? () => removeIfPresent(file)
          : () => Deno.writeFile(file, contents),
      ),
    ]);
  }
};
