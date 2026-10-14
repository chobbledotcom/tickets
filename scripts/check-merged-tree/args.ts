/** The command line the merged-tree check accepts: one head to merge and the
 *  base branch that receives the merge. */
export type ParsedArgs = {
  /** The branch on origin that receives the trial merge. */
  base: string;
  /** The head: one pull request number, or one branch on origin. */
  head: { kind: "pr"; number: number } | { kind: "ref"; name: string };
};

export type ParsedArgsResult =
  | { kind: "ok"; parsed: ParsedArgs }
  | { kind: "usage"; message: string };

export const usageLine =
  "usage: deno task check:merged-tree <pr-number | branch> [base]";

/** Parse the command line. A numeric argument names a pull request, which
 *  merges into main only. A named argument is a branch on origin; the base
 *  then defaults to main, and a second argument names the base branch. An
 *  "origin/" prefix on either name is optional. */
export const parseArgs = (args: readonly string[]): ParsedArgsResult => {
  if (args.length > 2) {
    return { kind: "usage", message: usageLine };
  }
  const [headArg, baseArg] = args;
  if (headArg === undefined) {
    return { kind: "usage", message: usageLine };
  }
  const baseWithPrefix = baseArg ?? "main";
  const base = baseWithPrefix.startsWith("origin/")
    ? baseWithPrefix.slice("origin/".length)
    : baseWithPrefix;
  if (base.length === 0) return { kind: "usage", message: usageLine };
  if (/^\d+$/.test(headArg)) {
    if (baseArg !== undefined) {
      return {
        kind: "usage",
        message:
          "A pull request number merges into main. Pass a branch to choose the base.",
      };
    }
    return {
      kind: "ok",
      parsed: { base, head: { kind: "pr", number: Number(headArg) } },
    };
  }
  const name = headArg.startsWith("origin/")
    ? headArg.slice("origin/".length)
    : headArg;
  if (name.length === 0) return { kind: "usage", message: usageLine };
  return { kind: "ok", parsed: { base, head: { kind: "ref", name } } };
};
