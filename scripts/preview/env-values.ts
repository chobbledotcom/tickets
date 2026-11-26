// effects: pure
/** Read the build environment values that a preview step needs. */

import { errorResult, okResult, type Result } from "#shared/result.ts";

/** The value of each named variable. A missing or blank variable fails the
 * run, and the error names every one that is missing. */
export const readEnvValues = (
  getEnv: (key: string) => string | undefined,
  names: readonly string[],
): Result<Map<string, string>> => {
  const values = names.map((name): [string, string] => [
    name,
    getEnv(name)?.trim() ?? "",
  ]);
  const missing = values.filter(([, value]) => value === "");
  return missing.length > 0
    ? errorResult(
        `Set these secrets for the preview: ${missing.map(([name]) => name).join(", ")}.`,
      )
    : okResult(new Map(values));
};
