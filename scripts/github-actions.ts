/**
 * Appends to the result files a GitHub Actions job exposes through env vars.
 *
 * The mutation runner and both sandbox e2e harnesses report through these.
 * The step summary is cosmetics, so its write is best-effort. The
 * `result=executed` output is a required handshake — the workflows' verify
 * steps read it — so a failure to write it propagates and fails the run
 * with the harness's own message instead of a bare verify-step refusal.
 */

const appendToActionsFile = (envVar: string, content: string): boolean => {
  const path = Deno.env.get(envVar);
  if (!path) return false;
  Deno.writeTextFileSync(path, content, { append: true });
  return true;
};

/** Append Markdown to the job's step summary panel. True when written. */
export const appendStepSummary = (markdown: string): boolean => {
  try {
    return appendToActionsFile("GITHUB_STEP_SUMMARY", markdown);
  } catch {
    // The summary is cosmetics; never fail a run over it.
    return false;
  }
};

/** Publish the `result=executed` output the workflows' verify steps read. */
export const publishExecutedResult = (): boolean =>
  appendToActionsFile("GITHUB_OUTPUT", "result=executed\n");
