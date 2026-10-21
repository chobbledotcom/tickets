/**
 * Where the graph's bare specifiers sit on disk.
 *
 * The scan's compiler resolves modules through `paths` alone, and the import
 * map does not name the npm packages the repository imports. `deno info` has
 * already resolved them, so the scan copies the answers it can use in: npm
 * packages and repository files. A remote jsr or https module cannot be
 * mapped usefully, and `cachedPathOf` says why.
 */

import { answered, pathIs } from "./host.ts";

/** The export map one cached npm package declares, read from the
 * `package.json` its cache folder holds. `undefined` when the package names
 * no map, so its subpaths are plain files of the package folder. */
export type ExportsOf = (folder: string) => unknown;

/** One dependency of a graph module, with the fields the mapping reads. */
export interface InfoDependency {
  code?: { specifier?: string };
  specifier?: string;
  type?: { specifier?: string };
}

/** One module of a `deno info --json` graph, with the fields the mapping
 * reads. */
export interface InfoModule {
  dependencies?: readonly InfoDependency[];
  local: string | null;
  npmPackage?: string;
  specifier: string;
}

/** The parts of `deno info --json` the mapping reads. */
export interface InfoJson {
  modules?: readonly InfoModule[];
  npmCache?: string;
  npmPackages?: Record<
    string,
    { name: string; version: string; registryUrl: string }
  >;
  redirects?: Record<string, string>;
}

/** Where one cached npm package of this version sits. The folder layout is
 * `<npmCache>/<registry host>/<name>/<version>`. */
const npmFolder = (
  npmCache: string,
  npm: { name: string; version: string; registryUrl: string },
): string =>
  `${npmCache}/${new URL(npm.registryUrl).host}/${npm.name}/${npm.version}`;

/** A bare specifier carries no URL scheme and no repository-relative prefix.
 * A scoped npm name starts with "@", and it is bare too. */
const isBareSpecifier = (specifier: string): boolean => {
  const head = specifier.charAt(0);
  return (
    specifier.length > 0 &&
    !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier) &&
    !["#", "/", "."].includes(head)
  );
};

/** What the mapping reads the graph and the cache through: the graph itself,
 * the cache folder it names, the export maps its packages declare, and the
 * checks that say the cache keeps a file and a package folder. */
interface Sources {
  exportsOf: ExportsOf;
  holds: (path: string) => boolean;
  holdsFolder: (path: string) => boolean;
  info: InfoJson;
  npmCache: string;
}

/** One export map entry the mapping resolves: the cached folder that holds
 * the package, the key the subpath matched, and the part of a pattern key
 * the `*` stood for. */
interface Entry {
  folder: string;
  key: string;
  matched?: string;
}

/** The bare dependency one module dependency answers: the specifier as the
 * repository writes it, with the cached path that resolves it, or nothing for
 * a dependency the graph leaves unmapped. The constraint names the concrete
 * module that the redirects table maps it to. */
const resolveDependency = (
  dependency: InfoDependency,
  moduleBySpecifier: Record<string, InfoModule>,
  redirects: Record<string, string>,
  sources: Sources,
): readonly [specifier: string, target: string] | undefined => {
  const written = dependency.specifier ?? "";
  if (!isBareSpecifier(written)) return;
  const constraint =
    dependency.code?.specifier ?? dependency.type?.specifier ?? "";
  const resolved = moduleBySpecifier[redirects[constraint] ?? constraint];
  const target = resolved && cachedPathOf(resolved, sources);
  return target === undefined ? undefined : [written, target];
};

/** The part of a subpath a pattern key's `*` stands for, or nothing when the
 * key is not a pattern or does not cover the subpath. */
const patternMatch = (key: string, subpath: string): string | undefined => {
  const star = key.indexOf("*");
  if (star === -1) return;
  const prefix = key.slice(0, star);
  const suffix = key.slice(star + 1);
  if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix)) return;
  return subpath.slice(prefix.length, subpath.length - suffix.length);
};

/** The conditions the mapping reads, in the order that finds the file the
 * compiler reads: declarations first, then the import conditions, then the
 * conditions a package answers with when it names no narrower one. */
const CONDITIONS = ["types", "import", "node", "default"] as const;

/** The cached file one export value names, with a pattern key's `*` filled
 * in. An export path is package-relative and always starts with `./`. */
const exportFileOf = (value: string, entry: Entry): string => {
  const written =
    entry.matched === undefined ? value : value.replace("*", entry.matched);
  if (!written.startsWith("./")) {
    throw new Error(
      `The package at ${entry.folder} exports ${entry.key} as ${written}, which is not a package path`,
    );
  }
  return `${entry.folder}/${written.slice(2)}`;
};

/** The cached file one export value resolves to. A path answers directly; a
 * condition map answers with the first condition it names of the ones the
 * mapping reads. A value the mapping cannot read is one the runtime resolved
 * some other way, so the mapping says so instead of pointing the compiler
 * at a guess. */
const conditionTargetOf = (value: unknown, entry: Entry): string => {
  if (typeof value === "string") {
    return exportFileOf(value, entry);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(
      `The package at ${entry.folder} exports ${entry.key} through a value the mapping cannot read`,
    );
  }
  const conditions = Object.entries(value);
  for (const condition of CONDITIONS) {
    const picked = conditions.find(([name]) => name === condition)?.[1];
    if (picked !== undefined && picked !== null) {
      return conditionTargetOf(picked, entry);
    }
  }
  throw new Error(
    `The package at ${entry.folder} exports ${entry.key} through conditions the mapping cannot read`,
  );
};

/** One pattern key a subpath's key covers, with the part of the key its `*`
 * stood for and the value the map pairs with the key. */
interface Pattern {
  entry: string;
  matched: string;
  value: unknown;
}

/** The pattern entries one subpath's key covers, with the part of the key
 * each `*` stood for. */
const coveredPatterns = (
  entries: readonly [string, unknown][],
  key: string,
): Pattern[] =>
  entries.flatMap(([entry, value]) => {
    const matched = patternMatch(entry, key);
    if (matched === undefined) return [];
    return [{ entry, matched, value }];
  });

/** The pattern whose star sits deepest stands for the subpath first; two
 * stars at the same depth go by the longer key. */
const byDeepestStar = (one: Pattern, other: Pattern): number => {
  const byStar = other.entry.indexOf("*") - one.entry.indexOf("*");
  if (byStar !== 0) return byStar;
  return other.entry.length - one.entry.length;
};

/** The cached file one subpath of a package with an export map resolves to.
 * The exact key answers first; otherwise the pattern key whose prefix before
 * its `*` is the longest stands for the subpath. A map that answers nothing
 * keeps the subpath out: the runtime could not have resolved it either. */
const exportsTargetOf = (
  exports: unknown,
  subpath: string,
  folder: string,
): string | undefined => {
  if (exports === undefined) return;
  // The package.json key the subpath answers: the subpath in the map's own
  // form, one dot ahead of the package root.
  const key = `.${subpath}`;
  if (typeof exports === "string") {
    throw new Error(
      `The package at ${folder} exports only its root, not ${key}`,
    );
  }
  if (
    exports === null ||
    Array.isArray(exports) ||
    typeof exports !== "object"
  ) {
    throw new Error(
      `The package at ${folder} declares an export map the mapping cannot read`,
    );
  }
  const entries = Object.entries(exports);
  const exact = entries.find(([entry]) => entry === key);
  if (exact !== undefined) {
    return conditionTargetOf(exact[1], { folder, key });
  }
  const patterns = coveredPatterns(entries, key).sort(byDeepestStar);
  if (patterns[0] === undefined) {
    throw new Error(`The package at ${folder} exports no ${key}`);
  }
  return conditionTargetOf(patterns[0].value, {
    folder,
    key,
    matched: patterns[0].matched,
  });
};

/** The cached file one subpath of a package sits at: the file the package's
 * own export map names, or the subpath's plain file when the package names
 * no map. The file a map names has to sit in the cache, because a map that
 * names an absent file would leave the compiler to resolve nothing, and the
 * scan would shrink in silence. A package that names no map can leave an
 * extensionless or directory subpath to the compiler's own resolution. The
 * cache only needs to hold the folder for such a target. */
const subpathTargetOf = (
  folder: string,
  subpath: string,
  sources: Sources,
): string => {
  const mapped = exportsTargetOf(sources.exportsOf(folder), subpath, folder);
  const target = mapped ?? `${folder}${subpath}`;
  if (sources.holds(target)) return target;
  if (mapped === undefined && sources.holdsFolder(target)) return target;
  if (mapped === undefined) {
    throw new Error(
      `The cached package at ${folder} resolves its ${subpath} to ${target}, and the cache holds no such file or folder`,
    );
  }
  throw new Error(
    `The cached package at ${folder} maps its ${subpath} to ${target}, and the cache holds no such file`,
  );
};

/** The cached path one npm module sits at, or nothing when the graph names no
 * package entry. A module at the package root sits in the package folder,
 * which the compiler reads with the package's own resolution; a subpath sits
 * at the file the package's export map names. Raises when the graph module
 * does not sit under its package, or when the cache holds no such folder. */
const npmPathOf = (
  npmPackage: string,
  specifier: string,
  sources: Sources,
): string | null => {
  const npm = sources.info.npmPackages?.[npmPackage];
  if (npm === undefined) return null;
  // The graph names a module `npm:/<name>@<version>` plus its subpath, so the
  // path after the package is the subpath the compiler resolves.
  const packagePrefix = `npm:/${npm.name}@${npm.version}`;
  if (!specifier.startsWith(packagePrefix)) {
    throw new Error(
      `The graph module ${specifier} does not sit under ${packagePrefix}`,
    );
  }
  const folder = npmFolder(sources.npmCache, npm);
  const subpath = specifier.slice(packagePrefix.length);
  if (subpath !== "") return subpathTargetOf(folder, subpath, sources);
  if (!sources.holdsFolder(folder)) {
    throw new Error(
      `The graph resolves ${specifier} to ${folder}, and the cache holds no such folder`,
    );
  }
  return folder;
};

/** The cached path one resolved module sits at, or nothing when the mapping
 * cannot use it. An npm package sits in its registry's folder under its
 * subpath, and a repository module carries its own file. A remote jsr or
 * https module answers nothing: Deno keeps those modules in its cache under
 * hashed, extensionless names beside unrelated modules, so TypeScript cannot
 * resolve a mapping to one or beside one, and the scan leaves a bare
 * specifier that resolves to one unmapped. */
const cachedPathOf = (
  resolved: InfoModule,
  sources: Sources,
): string | undefined => {
  if (resolved.npmPackage === undefined) {
    // Only a repository module's `local` names a usable file.
    return resolved.specifier.startsWith("file:")
      ? (resolved.local ?? undefined)
      : undefined;
  }
  return (
    npmPathOf(resolved.npmPackage, resolved.specifier, sources) ?? undefined
  );
};

/** Each bare specifier of the graph, with the cached path that resolves it.
 * The first answer wins, because one specifier resolves one way for the whole
 * graph. An npm subpath resolves through the export map the package's cache
 * folder declares, which `exportsOf` reads. `holds` says whether the cache
 * keeps the file the answer names, and `holdsFolder` says the same for a
 * package's folder. */
export const pathsFromInfo = (
  info: InfoJson,
  npmCache: string,
  exportsOf: ExportsOf,
  holds: (path: string) => boolean = pathIs("isFile"),
  holdsFolder: (path: string) => boolean = pathIs("isDirectory"),
): Record<string, string[]> => {
  const sources = { exportsOf, holds, holdsFolder, info, npmCache };
  const moduleBySpecifier: Record<string, InfoModule> = Object.fromEntries(
    info.modules?.map((module) => [module.specifier, module]) ?? [],
  );
  const redirects = info.redirects ?? {};
  const paths: Record<string, string[]> = {};
  for (const module of info.modules ?? []) {
    for (const dependency of module.dependencies ?? []) {
      const answer = resolveDependency(
        dependency,
        moduleBySpecifier,
        redirects,
        sources,
      );
      if (answer === undefined) continue;
      const [written, target] = answer;
      paths[written] ??= [target];
    }
  }
  return paths;
};

/** Ask `deno info` with the runtime that runs the scan. `Deno.execPath()`
 * names the parent runtime, so the graph never comes from a different
 * `deno` than the one the scan runs in. */
const runInfo = async (
  root: string,
  args: readonly string[],
): Promise<InfoJson> => {
  const output = await new Deno.Command(Deno.execPath(), {
    args: ["info", "--json", ...args],
    cwd: root,
    stderr: "piped",
    stdout: "piped",
  }).output();
  if (!output.success) {
    const said = new TextDecoder().decode(output.stderr).trim();
    throw new Error(
      `deno info ${args.join(" ")} failed: ${output.code}: ${said}`,
    );
  }
  return JSON.parse(new TextDecoder().decode(output.stdout));
};

/** The value of one settled spawn. A rejected spawn raises its reason, so the
 * scan says why the graph cannot be read. */
const settledValue = <T>(settled: PromiseSettledResult<T>): T => {
  if (settled.status === "rejected") throw settled.reason;
  return settled.value;
};

/** The export map one cached package declares, from the `package.json` its
 * cache folder holds. A package the graph resolved carries the file, so a
 * missing or broken one is a broken cache, and the error says where. A
 * package that names no map answers nothing, and its subpaths are plain
 * files of the package folder. */
const exportsOf = (folder: string): unknown => {
  const manifest = JSON.parse(Deno.readTextFileSync(`${folder}/package.json`));
  return manifest.exports;
};

/** The bare-specifier paths for the scan's compiler, from the module graph of
 * the repository's entry. A repository without its entry file has no graph to
 * ask, and its bare specifiers stay unmapped, as they were before this
 * mapping existed. */
export const barePaths = async (
  root: string,
  entry: string,
): Promise<Record<string, string[]>> => {
  if (!pathIs("isFile")(`${root}/${entry.replace(/^\.\//, "")}`)) return {};
  // Both spawns settle even when one fails, so no child or stream is left
  // behind when the scan raises. The graph's answer is settled first, so a
  // repository that cannot be read reports its own graph.
  const [graphed, bare] = await Promise.allSettled([
    runInfo(root, [entry]),
    runInfo(root, []),
  ]);
  return pathsFromInfo(
    settledValue(graphed),
    answered(settledValue(bare).npmCache, "npm cache folder"),
    exportsOf,
  );
};
