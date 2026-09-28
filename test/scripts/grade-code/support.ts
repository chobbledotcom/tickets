/** Fixtures and helpers shared by the grade-code CLI test files. */

import type { Alias } from "#scripts/check-imports/rules.ts";
import type { CliDeps } from "#scripts/grade-code/cli.ts";
import { JEV_QUESTIONS } from "#scripts/grade-code/questions.ts";

/** A file that passes every mechanical check. */
export const CLEAN_CODE = [
  "/** The sample code. */",
  'import { t } from "#i18n";',
  "",
  'export const render = (rows: string[]): string => rows.join(", ");',
  "",
].join("\n");

/** A file that breaks the import and catch rules precommit backs. */
export const BROKEN_CODE = [
  'import { t } from "#i18n";',
  'import type { Key } from "#i18n";',
  "try { run(); } catch {}",
  "export const value = 1;",
].join("\n");

const ALIASES: Alias[] = [
  { name: "#i18n", target: "./src/shared/i18n.ts" },
  { name: "#shared/", target: "./src/shared/" },
];

/** A Jev reply that answers every question well, with `extra` beside it. */
export const jevReply = (
  extra: Record<string, unknown> = {
    model: "jev-test",
    usage: { input_tokens: 10, output_tokens: 5 },
  },
): string =>
  JSON.stringify({
    answers: Object.fromEntries(
      JEV_QUESTIONS.map((question) => [
        question.id,
        { confidence: 0.9, score: 2.5, type: "score" },
      ]),
    ),
    ...extra,
  });

export const ioWith = (args: string[], env: Record<string, string> = {}) => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    err,
    io: {
      args,
      getEnv: (key: string) => env[key],
      stderr: (line: string) => err.push(line),
      stdout: (line: string) => out.push(line),
    },
    out,
  };
};

/** Fake repository inputs around one in-memory `src/` tree. */
export const depsOver = (dir: {
  dirs?: string[];
  files: Record<string, string>;
  fetchStatus?: number;
  secret?: string | null;
}): CliDeps => ({
  aliases: () => Promise.resolve(ALIASES),
  grade: {
    fetchText: () =>
      Promise.resolve({
        ok: dir.fetchStatus === undefined,
        status: dir.fetchStatus ?? 200,
        text: dir.fetchStatus === undefined ? jevReply() : "no credits",
      }),
    // A fixed clock, so a timing line reads the same on a loaded machine.
    now: () => 0,
    readFile: (path) => Promise.resolve(dir.files[path] ?? ""),
    sleep: () => Promise.resolve(),
  },
  listFiles: (root) =>
    Promise.resolve(
      Object.keys(dir.files).filter((file) => file.startsWith(`${root}/`)),
    ),
  overLimit: () => Promise.resolve({}),
  readSecret: () =>
    Promise.resolve(dir.secret === undefined ? null : dir.secret),
  stat: (path) =>
    Promise.resolve(
      Object.keys(dir.files).some((file) => file === path)
        ? "file"
        : Object.keys(dir.files).some((file) => file.startsWith(`${path}/`)) ||
            (dir.dirs ?? []).includes(path)
          ? "dir"
          : "missing",
    ),
  writeTextFile: (_path, _text) => Promise.resolve(),
});
