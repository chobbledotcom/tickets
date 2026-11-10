/** The rotate:db-key command-line walk: what it shows, when it refuses, and
 *  what it does to the site it takes. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import type { BuiltSite } from "#db/built-sites/types.ts";
import {
  type RotateDatabaseKeyCliDeps,
  runRotateDatabaseKeyCli,
} from "#scripts/rotate-database-key/run.ts";
import { errorResult, type Outcome, okResult } from "#shared/result.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testBuiltSite } from "#test-utils/factories.ts";

const bunnySite = (id: number, name: string): BuiltSite =>
  testBuiltSite({
    dbUrl: `libsql://${name}.lite.bunnydb.net`,
    hostingId: String(10 + id),
    id,
    name,
  });

interface CliState {
  deps: RotateDatabaseKeyCliDeps;
  invalidated: string[];
  issued: string[];
  prompts: string[];
  stderr: string[];
  stdout: string[];
  waited: number[];
}

/** A script run whose prompts answer in order and whose key steps are faked. */
const cliState = (
  options: {
    answers?: (string | null)[];
    args?: string[];
    invalidate?: Outcome;
    issue?: Outcome;
    sites?: BuiltSite[];
  } = {},
): CliState => {
  const answers = [...(options.answers ?? [])];
  const state = {
    invalidated: [] as string[],
    issued: [] as string[],
    prompts: [] as string[],
    stderr: [] as string[],
    stdout: [] as string[],
    waited: [] as number[],
  };
  const deps: RotateDatabaseKeyCliDeps = {
    args: options.args ?? [],
    getEnv: (key) => Deno.env.get(key),
    invalidateKey: (site) => {
      state.invalidated.push(site.name);
      return Promise.resolve(options.invalidate ?? okResult(undefined));
    },
    issueKey: (site) => {
      state.issued.push(site.name);
      return Promise.resolve(options.issue ?? okResult(undefined));
    },
    listSites: () => Promise.resolve(options.sites ?? [bunnySite(1, "one")]),
    prompt: (message) => {
      state.prompts.push(message);
      return answers.shift() ?? null;
    },
    stderr: (line) => state.stderr.push(line),
    stdout: (line) => state.stdout.push(line),
    wait: (seconds) => {
      state.waited.push(seconds);
      return Promise.resolve();
    },
  };
  return { deps, ...state };
};

const LOCAL_SITE = testBuiltSite({ dbUrl: "file:local.db", hostingId: "11" });
const SITES = {
  local: [LOCAL_SITE],
  none: [],
  one: [bunnySite(1, "one")],
};

/* jscpd:ignore-start -- a list of strings, not code */
/** Each walk that rotates nothing, or fails: the arguments, the sites, the
 * answers typed in order (a prompt past the last answer closes), the errors the
 * two key steps answer, the error line the person reads, and the sites each
 * step reached. A blank error line is a clean stop. */
const STOPPED_WALKS: [
  name: string,
  args: string,
  sites: keyof typeof SITES,
  answers: string,
  invalidateError: string,
  issueError: string,
  stderr: string,
  invalidated: string,
  issued: string,
  waited: string,
][] = [
  ["stops when the person quits", "", "one", "q", "", "", "", "", "", ""],
  ["stops when the menu prompt closes", "", "one", "", "", "", "", "", "", ""],
  [
    "refuses arguments and asks nothing",
    "one",
    "one",
    "",
    "",
    "",
    "Usage: deno task rotate:db-key",
    "",
    "",
    "",
  ],
  [
    "reports a host with no built sites",
    "",
    "none",
    "",
    "",
    "",
    "No built sites recorded.",
    "",
    "",
    "",
  ],
  [
    "refuses a database this host does not manage",
    "",
    "local",
    "1",
    "",
    "",
    "This site's database is a local file, so its key cannot be changed.",
    "",
    "",
    "",
  ],
  [
    "refuses a typed name that does not match",
    "",
    "one",
    "1|Other",
    "",
    "",
    "Site name does not match. Please type the exact name to confirm.",
    "",
    "",
    "",
  ],
  [
    "requires the site name",
    "",
    "one",
    "1|   ",
    "",
    "",
    "Site name is required.",
    "",
    "",
    "",
  ],
  [
    "stops when the confirmation prompt closes",
    "",
    "one",
    "1",
    "",
    "",
    "Cancelled.",
    "",
    "",
    "",
  ],
  [
    "reports a refused key removal and asks for no new key",
    "",
    "one",
    "1|one",
    "Revoke database tokens failed (500)",
    "",
    "Revoke database tokens failed (500)",
    "one",
    "",
    "",
  ],
  [
    "reports a refused new key after the wait",
    "",
    "one",
    "1|one",
    "",
    "Rotate database key failed (500)",
    "Rotate database key failed (500)",
    "one",
    "one",
    "60",
  ],
];
/* jscpd:ignore-end */

/** The words in `text` that `separator` divides, or none for a blank text. */
const listOf = (text: string, separator: string): string[] =>
  text ? text.split(separator) : [];

const MENU_PROMPT = "Choose a site to rotate the database key of (q to quit):";

describeWithEnv(
  "rotate database key CLI",
  { env: { BUNNY_API_KEY: "bunny-key" } },
  () => {
    test("removes the old key, waits a minute, then makes the new one", async () => {
      const state = cliState({
        answers: ["2", "Second"],
        sites: [bunnySite(1, "First"), bunnySite(2, "Second")],
      });

      expect(await runRotateDatabaseKeyCli(state.deps)).toBe(0);

      expect(state).toMatchObject({
        invalidated: ["Second"],
        issued: ["Second"],
        prompts: [MENU_PROMPT, "Type the site name to confirm (Second):"],
        stdout: [
          "\nSites:",
          "  1. First — bunny database (script 11)",
          "  2. Second — bunny database (script 12)",
          "The site cannot reach its database for about a minute, until it receives the new key. Run this when the site is quiet.",
          "Waiting 60 seconds for the database to remove every old key.",
          "Second now uses a new database key.",
        ],
        waited: [60],
      });
    });

    for (const walk of STOPPED_WALKS) {
      const [
        name,
        args,
        sites,
        answers,
        invalidateError,
        issueError,
        stderr,
        invalidated,
        issued,
        waited,
      ] = walk;
      test(name, async () => {
        const state = cliState({
          answers: listOf(answers, "|"),
          args: listOf(args, " "),
          invalidate: invalidateError
            ? errorResult(invalidateError)
            : okResult(undefined),
          issue: issueError ? errorResult(issueError) : okResult(undefined),
          sites: SITES[sites],
        });

        expect([
          await runRotateDatabaseKeyCli(state.deps),
          state.stderr,
          state.invalidated,
          state.issued,
          state.waited,
        ]).toEqual([
          stderr ? 1 : 0,
          listOf(stderr, "\n"),
          listOf(invalidated, "|"),
          listOf(issued, "|"),
          listOf(waited, "|").map(Number),
        ]);
      });
    }
  },
);
