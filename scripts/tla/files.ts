import { join, parse, relative, resolve } from "node:path";

/** The checkout root is trusted. Reject links in each source path below it. */
export const assertNoSymlink = async (path: string): Promise<void> => {
  const absolute = resolve(path);
  const inside = relative(Deno.cwd(), absolute);
  const root =
    inside === ".." || inside.startsWith("../")
      ? parse(absolute).root
      : Deno.cwd();
  let current = root;
  for (const part of relative(root, absolute).split("/").filter(Boolean)) {
    current = join(current, part);
    if ((await Deno.lstat(current)).isSymlink) {
      throw new Error(`A source path contains a symlink: ${path}`);
    }
  }
};

/** Collect every selected TLA source. Empty input and skipped links are errors. */
export const collectTlaSources = async (
  inputs: readonly string[],
): Promise<string[]> => {
  const files = new Set<string>();
  const visit = async (path: string): Promise<void> => {
    const info = await Deno.lstat(path);
    if (info.isSymlink) throw new Error(`Symlink is not a TLA source: ${path}`);
    if (info.isDirectory) {
      for await (const entry of Deno.readDir(path)) {
        await visit(join(path, entry.name));
      }
    } else if (info.isFile && path.endsWith(".tla")) {
      files.add(resolve(path));
    }
  };
  for (const input of inputs) {
    await assertNoSymlink(input);
    await visit(input);
  }
  if (files.size === 0) throw new Error("No TLA source inputs found.");
  return [...files].sort();
};
