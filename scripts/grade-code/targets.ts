/** Select authored source without expanding the default src-only sweep. */
import { relative, resolve } from "@std/path";

export interface TargetDeps {
  listFiles: (root: string) => Promise<string[]>;
  stat: (path: string) => Promise<"file" | "dir" | "missing">;
}

interface ResolvedTargets {
  error: string | null;
  targets: string[];
}

type SourceRoot = "src" | "verification";

type TargetSelection = {
  argument: string;
  directory: boolean;
  files: readonly string[];
  path: string;
  root: SourceRoot;
};

const sourceRoot = (file: string): SourceRoot | null => {
  for (const root of ["src", "verification"] as const) {
    if (file === root || file.startsWith(`${root}/`)) return root;
  }
  return null;
};

const selectTarget = async (
  argument: string,
  deps: TargetDeps,
): Promise<TargetSelection> => {
  const path = relative(Deno.cwd(), resolve(argument));
  const root = sourceRoot(path);
  if (root === null)
    throw new Error(`${argument} is not under src/ or verification/`);
  const kind = await deps.stat(path);
  if (kind === "missing") throw new Error(`cannot read ${argument}`);
  const files = kind === "file" ? [path] : await deps.listFiles(path);
  if (files.length === 0) throw new Error(`no source files under ${argument}`);
  return { argument, directory: kind === "dir", files, path, root };
};

const selectedSource = async (
  file: string,
  target: TargetSelection,
  deps: TargetDeps,
): Promise<string> => {
  const normalized = relative(Deno.cwd(), resolve(file));
  const supported =
    target.root === "verification"
      ? normalized.endsWith(".tla")
      : /\.[cm]?[jt]sx?$/.test(normalized);
  if (
    sourceRoot(normalized) !== target.root ||
    (target.directory && !normalized.startsWith(`${target.path}/`)) ||
    !supported
  ) {
    throw new Error(
      `unsupported source target ${file} under ${target.argument}`,
    );
  }
  if (target.directory && (await deps.stat(normalized)) !== "file") {
    throw new Error(`cannot read source target ${file}`);
  }
  return normalized;
};

/** Normalize before checking boundaries, including collector output. */
export const resolveTargets = async (
  args: string[],
  deps: TargetDeps,
): Promise<ResolvedTargets> => {
  try {
    const targets = new Set<string>();
    for (const arg of args.length === 0 ? ["src"] : args) {
      const target = await selectTarget(arg, deps);
      for (const file of target.files) {
        targets.add(await selectedSource(file, target, deps));
      }
    }
    return { error: null, targets: [...targets] };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      targets: [],
    };
  }
};
