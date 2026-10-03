import { isAbsolute } from "node:path";

/** Deno test flags that take a separate value, which is never a file path. */
const FILE_ARG_VALUE_FLAGS: Record<string, true> = {
  "--cert": true,
  "--conditions": true,
  "--config": true,
  "--env-file": true,
  "--ext": true,
  "--fail-fast": true,
  "--filter": true,
  "--ignore": true,
  "--junit-path": true,
  "--location": true,
  "--minimum-dependency-age": true,
  "--preload": true,
  "--require": true,
  "--seed": true,
  "--shuffle": true,
  "--v8-flags": true,
  "--watch": true,
  "--watch-exclude": true,
};

const TEST_FILE_RE =
  /(^|[/\\])__tests__[/\\].+\.[cm]?[jt]sx?$|(^|[/\\])[^/\\]+(?:[._]test)\.[cm]?[jt]sx?$/;

const TEST_DECLARATION_RE = /(^|[^\w$.])(?:Deno\.test|describe|it|test)\s*\(/g;
const TEST_OBJECT_DECLARATION_RE =
  /(^|[^\w$.])(?:Deno\.test|describe|it|test)\s*\{/g;
const TEST_STEP_RE = /\.\s*step\s*\(/g;

export const hasReporterArg = (args: string[]): boolean =>
  args.some((arg) => arg === "--reporter" || arg.startsWith("--reporter="));

const collectFileArgs = (args: string[]): string[] => {
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (arg === "--") break;
    if (arg.startsWith("-")) {
      if (FILE_ARG_VALUE_FLAGS[arg] && args[i + 1]?.startsWith("-") === false) {
        i++;
      }
      continue;
    }
    files.push(arg);
  }
  return files;
};

const walkTestFiles = async (path: string, files: string[]): Promise<void> => {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(path);
  } catch {
    return;
  }

  if (stat.isFile) {
    if (TEST_FILE_RE.test(path)) files.push(path);
    return;
  }

  if (!stat.isDirectory) return;
  for await (const entry of Deno.readDir(path)) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    await walkTestFiles(`${path}/${entry.name}`, files);
  }
};

const countMatches = (text: string, re: RegExp): number => {
  let count = 0;
  for (const _match of text.matchAll(re)) count++;
  return count;
};

export const estimateTapEventCount = async (
  cwd: string,
  args: string[],
): Promise<number | undefined> => {
  const fileArgs = collectFileArgs(args);
  if (fileArgs.length === 0) return;

  const files: string[] = [];
  for (const arg of fileArgs) {
    await walkTestFiles(isAbsolute(arg) ? arg : `${cwd}/${arg}`, files);
  }
  if (files.length === 0) return;

  let count = 0;
  for (const file of files) {
    const text = await Deno.readTextFile(file).catch(() => "");
    count += countMatches(text, TEST_DECLARATION_RE);
    count += countMatches(text, TEST_OBJECT_DECLARATION_RE);
    count += countMatches(text, TEST_STEP_RE);
  }

  return count || undefined;
};
