/**
 * Appends to the result files a GitHub Actions job exposes through env vars.
 *
 * The mutation runner and both sandbox e2e harnesses report through these.
 * Writes are best-effort: a summary or an output line is cosmetics or a
 * handshake, and a failure to write one must not fail a run that did real
 * work.
 */

const appendToActionsFile = (envVar: string, content: string): boolean => {
  const path = Deno.env.get(envVar);
  if (!path) return false;
  try {
    Deno.writeTextFileSync(path, content, { append: true });
    return true;
  } catch {
    // Best-effort: outside Actions, or an unwritable path, is not a failure.
    return false;
  }
};

/** Append Markdown to the job's step summary panel. True when written. */
export const appendStepSummary = (markdown: string): boolean =>
  appendToActionsFile("GITHUB_STEP_SUMMARY", markdown);

/** Publish the `result=executed` output the workflows' verify steps read. */
export const publishExecutedResult = (): boolean =>
  appendToActionsFile("GITHUB_OUTPUT", "result=executed\n");
