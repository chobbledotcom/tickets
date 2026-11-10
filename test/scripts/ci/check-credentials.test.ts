import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";

/**
 * The deploy workflows run scripts/ci/check-credentials.sh before the build,
 * so a wrong secret stops the run before a site changes. These tests stand a
 * stub curl in for the network. The stub answers each URL from a table and
 * records its arguments, which pins what the script asks each service.
 */

const scriptPath = join(projectRoot, "scripts", "ci", "check-credentials.sh");

const BUNNY_SCRIPTS = "https://api.bunny.net/compute/script?page=1&perPage=1";

const STUB_CURL = `#!/usr/bin/env bash
url="\${@: -1}"
printf '%s\\n' "$*" >> "$STUB_CALLS"
line=$(grep -F -m1 "$url|" "$STUB_RESPONSES") || { printf 000; exit 7; }
IFS='|' read -r _ status body <<<"$line"
case "$*" in
  *"--output /dev/null"*) printf '%s' "$status" ;;
  *) printf '%s' "$body" ;;
esac
`;

type Answers = Record<string, string>;
type Outcome = {
  calls: string[];
  code: number;
  stderr: string[];
  stdout: string[];
};

const lines = (text: string): string[] => text.split("\n").filter(Boolean);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** Runs the checks with the given secrets against a stub curl that answers
 * each URL with "status" or "status|body". */
const check = async (
  env: Record<string, string>,
  checks: string[],
  answers: Answers,
): Promise<Outcome> => {
  const dir = await Deno.makeTempDir({ prefix: "credential-check-" });
  try {
    const calls = join(dir, "calls");
    const responses = join(dir, "responses");
    await Deno.writeTextFile(calls, "");
    await Deno.writeTextFile(
      responses,
      Object.entries(answers)
        .map(([url, answer]) => `${url}|${answer}\n`)
        .join(""),
    );
    await Deno.writeTextFile(join(dir, "curl"), STUB_CURL, { mode: 0o755 });
    const result = await new Deno.Command("bash", {
      args: [scriptPath, ...checks],
      clearEnv: true,
      env: {
        PATH: `${dir}:${Deno.env.get("PATH") ?? ""}`,
        STUB_CALLS: calls,
        STUB_RESPONSES: responses,
        ...env,
      },
      stderr: "piped",
      stdout: "piped",
    }).output();
    return {
      calls: lines(await Deno.readTextFile(calls)),
      code: result.code,
      stderr: lines(decode(result.stderr)),
      stdout: lines(decode(result.stdout)),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

const STATUS_ONLY = "--silent --output /dev/null --write-out %{http_code}";
const LIMITS = "--max-time 20 --retry 2";

type Check = {
  /** The answer of a service that accepts the secret. */
  accepted: string;
  /** The curl arguments the check must send. */
  call: string;
  env: Record<string, string>;
  name: string;
  ok: string;
  probe: string;
  /** The value the skip message names. */
  skipped: string;
};

/* jscpd:ignore-start -- a list of strings, not code */
/** Each row: name, env as NAME=value pairs, curl output mode, request
 * arguments, probe URL, accepted answer, ok line, skipped value. */
const CHECK_ROWS: string[][] = [
  [
    "bunny",
    "BUNNY_ACCESS_KEY=bunny-key;SCRIPT_ID=42",
    "status",
    "-H AccessKey: bunny-key",
    "https://api.bunny.net/compute/script/42",
    "200",
    "Bunny accepts BUNNY_ACCESS_KEY and has the script",
    "BUNNY_ACCESS_KEY",
  ],
  [
    "main-instance",
    "MAIN_INSTANCE=https://main.example/;MAIN_INSTANCE_KEY=main-key",
    "status",
    "-X POST -H Authorization: Bearer main-key",
    "https://main.example/instance/site-credentials?tier=credential-check",
    "400",
    "the main instance accepts MAIN_INSTANCE_KEY",
    "MAIN_INSTANCE_KEY",
  ],
  [
    "backup-zone",
    "STORAGE_ZONE_NAME=backups;STORAGE_ZONE_KEY=zone-key",
    "status",
    "-H AccessKey: zone-key",
    "https://storage.bunnycdn.com/backups/.credential-check/",
    "200",
    "the backup storage zone accepts STORAGE_ZONE_KEY",
    "STORAGE_ZONE_KEY",
  ],
  [
    "cdn-zone",
    "CDN_BUNNY_STORAGE_HOST=uk.storage.example;CDN_BUNNY_STORAGE_ZONE_NAME=assets;CDN_BUNNY_STORAGE_ZONE_KEY=cdn-key",
    "status",
    "-H AccessKey: cdn-key",
    "https://uk.storage.example/assets/.credential-check/",
    "404",
    "the CDN storage zone accepts CDN_BUNNY_STORAGE_ZONE_KEY",
    "CDN_BUNNY_STORAGE_ZONE_KEY",
  ],
  [
    "site",
    "SITE_URL= https://tickets.example/ ",
    "body",
    "",
    "https://tickets.example/health",
    "200|Up :)",
    "the site answers at its URL",
    "SITE_URL",
  ],
];

/** Each row: check name, the answer of the service ("" when no answer
 * arrives), the case, the message. */
const REFUSAL_ROWS: string[][] = [
  ["bunny", "401", "Bunny refuses the key", "Bunny refused BUNNY_ACCESS_KEY."],
  [
    "bunny",
    "404",
    "Bunny has no such script",
    "Bunny has no edge script with the script id of this run.",
  ],
  [
    "bunny",
    "",
    "Bunny does not answer",
    "Bunny did not confirm BUNNY_ACCESS_KEY.",
  ],
  [
    "main-instance",
    "401",
    "the main instance refuses the key",
    "The main instance refused MAIN_INSTANCE_KEY.",
  ],
  [
    "main-instance",
    "404",
    "the main instance has no credentials endpoint",
    "MAIN_INSTANCE has no credentials endpoint. The main instance must have MAIN_INSTANCE_KEY set.",
  ],
  [
    "main-instance",
    "503",
    "the main instance fails",
    "The main instance at MAIN_INSTANCE did not confirm MAIN_INSTANCE_KEY.",
  ],
  [
    "backup-zone",
    "401",
    "the backup zone refuses the key",
    "The backup storage zone refused STORAGE_ZONE_KEY, or STORAGE_ZONE_NAME names another zone.",
  ],
  [
    "cdn-zone",
    "403",
    "the CDN zone refuses the key",
    "The CDN storage zone refused CDN_BUNNY_STORAGE_ZONE_KEY, or CDN_BUNNY_STORAGE_ZONE_NAME names another zone.",
  ],
  [
    "cdn-zone",
    "",
    "the CDN zone does not answer",
    "The CDN storage zone did not confirm CDN_BUNNY_STORAGE_ZONE_KEY.",
  ],
  [
    "site",
    "200|<html>Hello</html>",
    "another site answers at the URL",
    "The site URL of this run does not answer as a tickets site. The update wait polls this URL.",
  ],
];
/* jscpd:ignore-end */

const envOf = (pairs: string): Record<string, string> =>
  Object.fromEntries(
    pairs.split(";").map((pair) => {
      const at = pair.indexOf("=");
      return [pair.slice(0, at), pair.slice(at + 1)];
    }),
  );

const checkOf = (row: string[]): Check => {
  const [name, pairs, mode, request, probe, accepted, ok, skipped] = row;
  const output = mode === "body" ? "--silent" : STATUS_ONLY;
  return {
    accepted: accepted!,
    call: [output, LIMITS, request, probe].filter(Boolean).join(" "),
    env: envOf(pairs!),
    name: name!,
    ok: ok!,
    probe: probe!,
    skipped: skipped!,
  };
};

const CHECKS = CHECK_ROWS.map(checkOf);

const checkNamed = (name: string): Check => {
  const found = CHECKS.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`No check is named ${name}`);
  return found;
};

const allNames = CHECKS.map(({ name }) => name);
const allEnv = Object.assign({}, ...CHECKS.map(({ env }) => env));
const allAccepted = Object.fromEntries(
  CHECKS.map(({ probe, accepted }) => [probe, accepted]),
);

type Refusal = {
  /** The answer of the service, or "" when no answer arrives. */
  answer: string;
  check: Check;
  message: string;
  when: string;
};

const refusalOf = (row: string[]): Refusal => {
  const [name, answer, when, message] = row;
  return {
    answer: answer!,
    check: checkNamed(name!),
    message: message!,
    when: when!,
  };
};

const REFUSALS = REFUSAL_ROWS.map(refusalOf);

const answersOf = ({ answer, check }: Refusal): Answers =>
  answer === "" ? {} : { [check.probe]: answer };

describe("the workflow credential check", () => {
  test("passes when every service accepts its secret", async () => {
    expect(await check(allEnv, allNames, allAccepted)).toEqual({
      calls: CHECKS.map(({ call }) => call),
      code: 0,
      stderr: [],
      stdout: CHECKS.map(({ ok }) => `ok: ${ok}`),
    });
  });

  test("skips a check with no credential set, and asks nothing", async () => {
    expect(await check({}, allNames, {})).toEqual({
      calls: [],
      code: 0,
      stderr: [],
      stdout: CHECKS.map(({ skipped }) => `skipped: ${skipped} is not set`),
    });
  });

  test("checks the Bunny key alone when the run has no script id", async () => {
    const outcome = await check({ BUNNY_ACCESS_KEY: "bunny-key" }, ["bunny"], {
      [BUNNY_SCRIPTS]: "200",
    });

    expect(outcome).toEqual({
      calls: [
        `${STATUS_ONLY} ${LIMITS} -H AccessKey: bunny-key ${BUNNY_SCRIPTS}`,
      ],
      code: 0,
      stderr: [],
      stdout: ["ok: Bunny accepts BUNNY_ACCESS_KEY"],
    });
  });

  test("accepts a main instance that ignores the tier", async () => {
    const main = checkNamed("main-instance");
    const outcome = await check(main.env, [main.name], { [main.probe]: "200" });

    expect(outcome.stdout).toEqual([`ok: ${main.ok}`]);
  });

  for (const refusal of REFUSALS) {
    test(`fails when ${refusal.when}`, async () => {
      const refused = refusal.check;
      const outcome = await check(
        refused.env,
        [refused.name],
        answersOf(refusal),
      );

      expect(outcome).toEqual({
        calls: [refused.call],
        code: 1,
        stderr: [`::error::${refusal.message}`],
        stdout: [],
      });
    });
  }

  test("reports every refusal in one run", async () => {
    const outcome = await check(allEnv, ["bunny", "main-instance", "site"], {
      ...allAccepted,
      [checkNamed("bunny").probe]: "401",
      [checkNamed("main-instance").probe]: "401",
    });

    expect({
      code: outcome.code,
      stderr: outcome.stderr,
      stdout: outcome.stdout,
    }).toEqual({
      code: 1,
      stderr: [
        "::error::Bunny refused BUNNY_ACCESS_KEY.",
        "::error::The main instance refused MAIN_INSTANCE_KEY.",
      ],
      stdout: ["ok: the site answers at its URL"],
    });
  });

  test("refuses a check it does not know", async () => {
    const outcome = await check({}, ["database"], {});

    expect(outcome).toEqual({
      calls: [],
      code: 2,
      stderr: ["Unknown check: database"],
      stdout: [],
    });
  });
});
