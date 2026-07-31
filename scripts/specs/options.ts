import { splitFlagValues } from "#scripts/flag-values.ts";
import { isFeaturePath, isSpecPath } from "./paths.ts";

export interface SpecCliOptions {
  paths: string[];
  tags?: string;
}

export interface FocusedTargets {
  specPaths: string[];
  tags?: string;
  testArgs: string[];
}

export const shouldRunFocusedSpecs = (
  targets: Pick<FocusedTargets, "specPaths" | "tags">,
): boolean => targets.specPaths.length > 0 || targets.tags !== undefined;

interface SpecSelection {
  paths?: readonly string[];
  tags?: string;
}

export const shouldCheckUnusedSteps = (selection: SpecSelection): boolean =>
  selection.paths === undefined && selection.tags === undefined;

const tagExpression = (value: string | undefined): string => {
  if (!value || value.startsWith("--")) {
    throw new Error("--tags needs a tag expression");
  }
  return value;
};

const DIRECT_OPTIONS_WITH_VALUES = new Set([
  "--cert",
  "--conditions",
  "--config",
  "--ext",
  "--filter",
  "--import-map",
  "--junit-path",
  "--location",
  "--lock",
  "--minimum-dependency-age",
  "--preload",
  "--reporter",
  "--seed",
  "-c",
]);

const directArgumentCount = (args: string[], index: number): number => {
  const arg = args[index]!;
  if (arg === "--") return args.length - index;
  if (!arg.startsWith("-")) return 0;
  if (!DIRECT_OPTIONS_WITH_VALUES.has(arg)) return 1;
  const value = args[index + 1];
  return value !== undefined && !value.startsWith("--") ? 2 : 1;
};

export const parseSpecArgs = (args: string[]): SpecCliOptions => {
  const { rest, values } = splitFlagValues(args, "--tags");
  const unknown = rest.find((value) => value.startsWith("--"));
  if (unknown) throw new Error(`Unknown specs option ${unknown}`);
  // Every occurrence is checked, and like repeated flags anywhere, the last wins.
  const tags = values.map(tagExpression).at(-1);
  return { paths: rest, ...(tags === undefined ? {} : { tags }) };
};

export const focusedTargets = (args: string[]): FocusedTargets => {
  const specPaths: string[] = [];
  const testArgs: string[] = [];
  let tags: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--tags") {
      tags = tagExpression(args[++index]);
      continue;
    }
    const directCount = directArgumentCount(args, index);
    if (directCount > 0) {
      testArgs.push(...args.slice(index, index + directCount));
      index += directCount - 1;
      continue;
    }
    if (isFeaturePath(arg) || isSpecPath(arg)) {
      specPaths.push(arg);
      continue;
    }
    testArgs.push(arg);
  }
  return { specPaths, testArgs, ...(tags === undefined ? {} : { tags }) };
};
