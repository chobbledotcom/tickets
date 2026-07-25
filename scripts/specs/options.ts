export interface SpecCliOptions {
  paths: string[];
  tags?: string;
}

export interface FocusedTargets {
  specPaths: string[];
  tags?: string;
  testArgs: string[];
}

interface SpecSelection {
  paths?: readonly string[];
  tags?: string;
}

export const shouldCheckUnusedSteps = (selection: SpecSelection): boolean =>
  selection.paths === undefined && selection.tags === undefined;

export const parseSpecArgs = (args: string[]): SpecCliOptions => {
  const paths: string[] = [];
  let tags: string | undefined;
  const remaining = [...args];
  while (remaining.length > 0) {
    const value = remaining.shift()!;
    if (value === "--tags") {
      const expression = remaining.shift();
      if (!expression || expression.startsWith("--")) {
        throw new Error("--tags needs a tag expression");
      }
      tags = expression;
    } else if (value.startsWith("--")) {
      throw new Error(`Unknown specs option ${value}`);
    } else paths.push(value);
  }
  return { paths, ...(tags === undefined ? {} : { tags }) };
};

export const focusedTargets = (args: string[]): FocusedTargets => {
  const specPaths = args.filter((arg) => arg.endsWith(".feature"));
  const testArgs: string[] = [];
  let tags: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg.endsWith(".feature")) continue;
    if (arg === "--tags") {
      const value = args[++index];
      if (!value) throw new Error("--tags needs a tag expression");
      tags = value;
      continue;
    }
    testArgs.push(arg);
  }
  return { specPaths, testArgs, ...(tags === undefined ? {} : { tags }) };
};
