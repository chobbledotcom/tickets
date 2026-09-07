// The post-edit check pipeline: which checks an edited file triggers, the
// order they run in, and how the results read. The plugin in
// .opencode/plugins/ wires this to the editor and to the tool runner.

export type CheckResult = { label: string; ok: boolean; text: string };
export type ToolRun = { ok: boolean; text: string };
export type RunTool = (args: string[]) => Promise<ToolRun>;

// The trees deno task lint passes to Biome.
const LINT_TREES = ["src/", "test/", "scripts/", "cli/", "e2e-payments/"];

// Skipped by biome.json: generated or vendored code.
const BIOME_SKIP_TREES = ["src/static/", "src/ui/static/"];
const BIOME_SKIP_FILES = ["src/ui/client/scanner.js"];

export const biomeApplies = (relPath: string): boolean =>
  /\.(?:js|ts|tsx)$/.test(relPath) &&
  LINT_TREES.some((tree) => relPath.startsWith(tree)) &&
  !BIOME_SKIP_TREES.some((tree) => relPath.startsWith(tree)) &&
  !BIOME_SKIP_FILES.includes(relPath);

export type ScanRun = { config: string; paths?: string[] };

// Every jscpd config whose scan covers the edited file's tree. A src edit
// also runs the specs and helpers configs because those compare the test
// helper trees against src, so a src edit can create a cross-tree clone.
export const scansFor = (relPath: string): ScanRun[] => {
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
    relPath.startsWith("e2e-payments/") ||
    relPath.startsWith("scripts/")
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

const MAX_LINES = 120;

const stripAnsi = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour
  text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// Drop ANSI escapes, the config-load chatter, and the cpd.ts policy
// banner: the banner repeats guidance AGENTS.md already carries.
const cleanText = (text: string): string =>
  cutBanner(
    stripAnsi(text)
      .split("\n")
      .filter((line) => !isChatter(line))
      .join("\n"),
  );

const isChatter = (line: string): boolean =>
  line.startsWith("config file ") || line.startsWith("Using config from ");

const cutBanner = (text: string): string => {
  const banner = text.indexOf("━");
  return banner === -1 ? text : text.slice(0, banner);
};

const splitLines = (text: string): string[] => text.split("\n");

const cap = (text: string): string => {
  const lines = splitLines(text);
  return (
    lines.slice(0, MAX_LINES).join("\n") +
    (lines.length > MAX_LINES ? "\n… truncated" : "")
  );
};

const lastLine = (text: string): string => {
  const lines = splitLines(text).filter((line) => line.trim() !== "");
  return lines[lines.length - 1] ?? "clean";
};

export const formatBiome = (result: CheckResult): string => {
  const text = cleanText(result.text);
  return result.ok
    ? `biome: ${lastLine(text)}`
    : `biome: found lint issues\n${cap(text)}`;
};

export const formatScans = (results: CheckResult[]): string => {
  const failed = results.filter((result) => !result.ok);
  if (failed.length === 0) {
    return `jscpd: clean (${results.map((result) => result.label).join(", ")})`;
  }
  return failed
    .map(
      (result) =>
        `jscpd: duplicated code found (${result.label})\n${cap(
          cleanText(result.text),
        )}`,
    )
    .join("\n\n");
};

export const createPipeline = ({
  runTool,
}: {
  runTool: RunTool;
}): ((relPath: string) => Promise<string>) => {
  // One pipeline at a time: an edit's Biome write finishes before the next
  // edit's jscpd scans start, so a scan never reads a half-rewritten tree.
  // A run queued by a later edit re-runs after the one before it.
  let tail: Promise<unknown> = Promise.resolve();
  const queued = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task);
    tail = next.catch(() => {});
    return next;
  };

  const runCheck = async (
    label: string,
    args: string[],
  ): Promise<CheckResult> => {
    const { ok, text } = await runTool(args);
    return { label, ok, text };
  };

  const biomeCheck = (relPath: string): Promise<CheckResult> =>
    runCheck("biome", [
      "scripts/biome.ts",
      "check",
      "--write",
      "--error-on-warnings",
      relPath,
    ]);

  const scanRun = (run: ScanRun): Promise<CheckResult> =>
    runCheck(run.config, [
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

  // Returns the check output for one edited file, or "" when no check
  // applies to it.
  return async (relPath: string): Promise<string> => {
    if (!biomeApplies(relPath) && scansFor(relPath).length === 0) return "";
    return queued(async () => {
      const sections: string[] = [];
      // Biome first: it can rewrite the file, and the scans must see
      // the rewritten text.
      if (biomeApplies(relPath)) {
        sections.push(formatBiome(await biomeCheck(relPath)));
      }
      const runs = scansFor(relPath);
      if (runs.length > 0) {
        sections.push(formatScans(await Promise.all(runs.map(scanRun))));
      }
      return sections.join("\n\n");
    });
  };
};
