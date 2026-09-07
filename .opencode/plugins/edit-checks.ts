// After each file edit: run Biome on the edited file (it fixes what it can
// in place), then run the repo's jscpd configs that scan the edited file's
// tree. Both results are appended to the tool output the model sees.
import { isAbsolute, relative } from "node:path";
import type { Plugin } from "@opencode-ai/plugin";

type CheckResult = { label: string; ok: boolean; text: string };

// The trees deno task lint passes to Biome.
const LINT_TREES = ["src/", "test/", "scripts/", "cli/", "e2e-payments/"];

// Skipped by biome.json: generated or vendored code.
const BIOME_SKIP_TREES = ["src/static/", "src/ui/static/"];
const BIOME_SKIP_FILES = ["src/ui/client/scanner.js"];

const biomeApplies = (relPath: string): boolean =>
  /\.(?:js|ts|tsx)$/.test(relPath) &&
  LINT_TREES.some((tree) => relPath.startsWith(tree)) &&
  !BIOME_SKIP_TREES.some((tree) => relPath.startsWith(tree)) &&
  !BIOME_SKIP_FILES.includes(relPath);

type ScanRun = { config: string; paths?: string[] };

// Every jscpd config whose scan covers the edited file's tree. A src edit
// also runs the specs and helpers configs because those compare the test
// helper trees against src, so a src edit can create a cross-tree clone.
const scansFor = (relPath: string): ScanRun[] => {
  // The scss config needs the file path positionally: jscpd v5 does not
  // scan directories when scss is the only format. The code configs do
  // not list scss, so this file gets no other scan.
  if (relPath === "src/ui/static/style.scss") {
    return [{ config: ".jscpd.css.json", paths: [relPath] }];
  }
  if (!/\.(?:ts|tsx|js|jsx|json)$/.test(relPath)) return [];
  const runs: ScanRun[] = [];
  const add = (config: string) => runs.push({ config });
  if (relPath.startsWith("src/")) {
    add(".jscpd.json");
    add(".jscpd.specs.json");
    add(".jscpd.helpers.json");
  } else if (
    relPath.startsWith("e2e-payments/") || relPath.startsWith("scripts/")
  ) {
    add(".jscpd.json");
  } else if (relPath.startsWith("test/specs/support/")) {
    add(".jscpd.specs.json");
    add(".jscpd.support.json");
  } else if (relPath.startsWith("test/test-utils/")) {
    add(".jscpd.helpers.json");
    add(".jscpd.test.json");
  } else if (relPath.startsWith("test/")) {
    add(".jscpd.test.json");
  }
  return runs;
};

const stripAnsi = (text: string): string =>
  text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// Drop config-load chatter and the cpd.ts policy banner: the banner
// repeats guidance AGENTS.md already carries.
const cleanText = (text: string): string =>
  stripAnsi(text)
    .split("\n")
    .filter((line) =>
      !line.startsWith("config file ") &&
      !line.startsWith("Using config from ")
    )
    .join("\n")
    .split("━")[0]
    .trim();

const MAX_LINES = 120;

const cap = (text: string): string => {
  const lines = text.split("\n");
  return lines.slice(0, MAX_LINES).join("\n") +
    (lines.length > MAX_LINES ? "\n… truncated" : "");
};

const lastLine = (text: string): string => {
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  return lines[lines.length - 1] ?? "clean";
};

const formatBiome = (result: CheckResult): string =>
  result.ok
    ? `biome: ${lastLine(result.text)}`
    : `biome: found lint issues\n${cap(result.text)}`;

const formatScans = (results: CheckResult[]): string => {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    return `jscpd: clean (${
      results.map((result) => result.label).join(", ")
    })`;
  }
  return failed
    .map((result) =>
      `jscpd: duplicated code found (${result.label})\n${cap(result.text)}`
    )
    .join("\n\n");
};

export default (async ({ $, worktree }) => {
  // Inside the nix devshell the pinned deno is already on PATH. Outside
  // it, nix develop provides it, as AGENTS.md requires for tools.
  const prefix = process.env.IN_NIX_SHELL
    ? ["deno"]
    : ["nix", "develop", "-c", "deno"];

  const runTool = async (
    args: string[],
  ): Promise<{ ok: boolean; text: string }> => {
    try {
      const proc = await $`${[...prefix, "run", "-A", ...args]}`
        .nothrow()
        .quiet()
        .cwd(worktree);
      return {
        ok: proc.exitCode === 0,
        text: cleanText(`${proc.stdout}\n${proc.stderr}`),
      };
    } catch (err) {
      return { ok: false, text: `check hook could not run: ${err}` };
    }
  };

  // One queue per file or config: runs on the same target never overlap,
  // and a run queued by a later edit re-runs after the one before it.
  const queues = new Map<string, Promise<unknown>>();
  const queued = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.then(task);
    queues.set(key, next.catch(() => {}));
    return next;
  };

  const biomeCheck = (relPath: string): Promise<CheckResult> =>
    queued(`biome:${relPath}`, async () => {
      const { ok, text } = await runTool([
        "scripts/biome.ts",
        "check",
        "--write",
        "--error-on-warnings",
        relPath,
      ]);
      return { label: "biome", ok, text };
    });

  const scanRun = (run: ScanRun): Promise<CheckResult> =>
    queued(`jscpd:${run.config}`, async () => {
      const { ok, text } = await runTool([
        "scripts/cpd.ts",
        "--config",
        run.config,
        ...(run.paths ?? []),
        // The ai reporter prints one line per clone pair and writes no
        // report directory, so scans cannot contend on report files.
        "--reporters",
        "ai",
        "--no-tips",
      ]);
      return { label: run.config, ok, text };
    });

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "edit" && input.tool !== "write") return;
      const raw: unknown = input.args?.filePath;
      if (typeof raw !== "string") return;
      const relPath = (isAbsolute(raw) ? relative(worktree, raw) : raw)
        .replaceAll("\\", "/")
        .replace(/^\.\//, "");
      if (relPath.startsWith("..")) return;
      try {
        const sections: string[] = [];
        // Biome first: it can rewrite the file, and the scans must see
        // the rewritten text.
        if (biomeApplies(relPath)) {
          sections.push(formatBiome(await biomeCheck(relPath)));
        }
        const runs = scansFor(relPath);
        if (runs.length > 0) {
          const results = await Promise.all(runs.map(scanRun));
          sections.push(formatScans(results));
        }
        if (sections.length > 0) {
          output.output += `\n\n${sections.join("\n\n")}`;
        }
      } catch (err) {
        output.output += `\n\nedit-checks hook failed: ${err}`;
      }
    },
  };
}) satisfies Plugin;
