/**
 * Command-line arguments for the PR queue report. Pure: it reads the argument
 * list and hands back what was asked for, or the wording of the first mistake.
 * The entry script decides what to print and which exit code to use.
 */

import { reduce } from "#fp";
import { stripControlChars } from "./sanitize.ts";

export const PR_QUEUE_USAGE = `PR queue report — scans open PRs and prints a plain-language status for each.

Usage: deno task pr-queue [-- --json] [-- --repo owner/name]

Options:
  --json              Print structured summaries as JSON instead of the grouped report.
  --repo owner/name   Inspect a repo other than the current one.
  -h, --help          Show this help.`;

export interface PrQueueArgs {
  error?: string;
  help: boolean;
  json: boolean;
  repo?: string | undefined;
}

/**
 * What has been read so far. `awaitingRepo` remembers that the last argument
 * was "--repo", so whatever comes next is its value, even if it looks like a
 * flag. A trailing "--repo" leaves that set, which becomes an error rather than
 * a silent fall-back to working the repo out.
 */
interface ArgsAcc extends PrQueueArgs {
  awaitingRepo: boolean;
}

/** Add one argument to what has been read. */
const readArg = (acc: ArgsAcc, arg: string): ArgsAcc => {
  if (acc.error !== undefined) return acc;
  if (acc.awaitingRepo) return { ...acc, awaitingRepo: false, repo: arg };
  if (arg === "--json") return { ...acc, json: true };
  if (arg === "--repo") return { ...acc, awaitingRepo: true };
  if (arg === "-h" || arg === "--help") return { ...acc, help: true };
  // The argument is echoed back to the terminal, so strip control bytes first.
  return { ...acc, error: `Unknown argument: ${stripControlChars(arg)}` };
};

/** What the arguments asked for, or the wording of the first mistake in them. */
export const parsePrQueueArgs = (args: string[]): PrQueueArgs => {
  const { awaitingRepo, ...rest } = reduce(readArg, {
    awaitingRepo: false,
    help: false,
    json: false,
  } as ArgsAcc)(args);
  return awaitingRepo && rest.error === undefined
    ? { ...rest, error: "--repo requires a value" }
    : rest;
};
