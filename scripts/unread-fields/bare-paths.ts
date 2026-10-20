/**
 * Where the graph's bare specifiers sit on disk.
 *
 * The scan's compiler resolves modules through `paths` alone, and the import
 * map does not name the npm and jsr packages the repository imports. `deno
 * info` has already resolved them, so the scan copies its answers in.
 */

import { answered, pathIs } from "./host.ts";

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

/** The bare dependency one module dependency answers: the specifier as the
 * repository writes it, with the cached path that resolves it, or nothing for
 * a dependency the graph leaves unmapped. The constraint names the concrete
 * module that the redirects table maps it to. */
const resolveDependency = (
  dependency: InfoDependency,
  moduleBySpecifier: Record<string, InfoModule>,
  redirects: Record<string, string>,
  info: InfoJson,
  npmCache: string,
): readonly [specifier: string, target: string] | undefined => {
  const written = dependency.specifier ?? "";
  if (!isBareSpecifier(written)) return;
  const constraint =
    dependency.code?.specifier ?? dependency.type?.specifier ?? "";
  const resolved = moduleBySpecifier[redirects[constraint] ?? constraint];
  const target = resolved && cachedPathOf(resolved, info, npmCache);
  return target === undefined ? undefined : [written, target];
};

/** The cached folder one npm module sits in, with the module's subpath after
 * it, or nothing when the graph names no package entry. Raises when the graph
 * module does not sit under its package. */
const npmPathOf = (
  npmPackage: string,
  specifier: string,
  info: InfoJson,
  npmCache: string,
): string | null => {
  const npm = info.npmPackages?.[npmPackage];
  if (npm === undefined) return null;
  // The graph names a module `npm:/<name>@<version>` plus its subpath, so the
  // path after the package is the subpath the compiler resolves.
  const packagePrefix = `npm:/${npm.name}@${npm.version}`;
  if (!specifier.startsWith(packagePrefix)) {
    throw new Error(
      `The graph module ${specifier} does not sit under ${packagePrefix}`,
    );
  }
  return `${npmFolder(npmCache, npm)}${specifier.slice(packagePrefix.length)}`;
};

/** The cached path one resolved module sits at, or nothing when the graph
 * names no place for it. An npm package sits in its registry's folder under
 * its subpath; a jsr or https module carries its own file. */
const cachedPathOf = (
  resolved: InfoModule,
  info: InfoJson,
  npmCache: string,
): string | undefined => {
  const target =
    resolved.npmPackage === undefined
      ? resolved.local
      : npmPathOf(resolved.npmPackage, resolved.specifier, info, npmCache);
  return target ?? undefined;
};

/** Each bare specifier of the graph, with the cached path that resolves it.
 * The first answer wins, because one specifier resolves one way for the whole
 * graph. */
export const pathsFromInfo = (
  info: InfoJson,
  npmCache: string,
): Record<string, string[]> => {
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
        info,
        npmCache,
      );
      if (answer === undefined) continue;
      const [written, target] = answer;
      paths[written] ??= [target];
    }
  }
  return paths;
};

/** Ask `deno info` through the runtime's own executable. The task permission
 * resolves its `deno` allow-list entry through PATH and canonicalizes it, so
 * this absolute path matches the grant, and the child is the runtime that
 * runs the scan, not a name PATH selects again. */
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
  );
};
