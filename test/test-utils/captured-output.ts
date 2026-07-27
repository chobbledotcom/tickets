import type { CapturedOutput } from "#scripts/process.ts";

/** What a command that worked printed and returned. */
export const capturedOk = (stdout = ""): CapturedOutput => ({
  code: 0,
  stderr: "",
  stdout,
  success: true,
});

/** What a command that failed printed and returned. */
export const capturedFail = (
  code = 1,
  stderr = "",
  stdout = "",
): CapturedOutput => ({
  code,
  stderr,
  stdout,
  success: false,
});
