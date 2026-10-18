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

/** The module one dependency's constraint resolves to, after the redirects
 * table has had its say. A constraint such as "npm:valibot@^1.4.1" names the
 * concrete module the redirects table maps it to. */
const resolvesTo = (
  dependency: InfoDependency,
  moduleBySpecifier: ReadonlyMap<string, InfoModule>,
  redirects: Record<string, string>,
): InfoModule | undefined => {
  const constraint =
    dependency.code?.specifier ?? dependency.type?.specifier ?? "";
  return moduleBySpecifier.get(redirects[constraint] ?? constraint);
};

/** The cached path one resolved module sits at, or nothing when the graph
 * names no place for it. An npm package sits in its registry's folder; a jsr
 * or https module carries its own file. */
const cachedPathOf = (
  resolved: InfoModule,
  info: InfoJson,
  npmCache: string,
): string | undefined => {
  if (resolved.npmPackage === undefined) return resolved.local ?? undefined;
  const npm = info.npmPackages?.[resolved.npmPackage];
  return npm === undefined ? undefined : npmFolder(npmCache, npm);
};

/** The answers one graph contributes: each bare dependency of any module,
 * with the cached path that resolves it, or nothing for a dependency the
 * graph leaves unmapped. */
const resolverOf = (info: InfoJson, npmCache: string) => {
  const moduleBySpecifier = new Map(
    info.modules?.map((module) => [module.specifier, module]),
  );
  const redirects = info.redirects ?? {};
  return (
    dependency: InfoDependency,
  ): readonly [specifier: string, target: string] | undefined => {
    const written = dependency.specifier ?? "";
    if (!isBareSpecifier(written)) return;
    const resolved = resolvesTo(dependency, moduleBySpecifier, redirects);
    const target = resolved && cachedPathOf(resolved, info, npmCache);
    return target === undefined ? undefined : [written, target];
  };
};

/** Each bare specifier of the graph, with the cached path that resolves it.
 * The first answer wins, because one specifier resolves one way for the whole
 * graph. */
export const pathsFromInfo = (
  info: InfoJson,
  npmCache: string,
): Record<string, string[]> => {
  const resolve = resolverOf(info, npmCache);
  const paths: Record<string, string[]> = {};
  for (const module of info.modules ?? []) {
    for (const dependency of module.dependencies ?? []) {
      const answer = resolve(dependency);
      if (answer === undefined) continue;
      const [written, target] = answer;
      paths[written] ??= [target];
    }
  }
  return paths;
};

/** Ask `deno info` with this runtime's own executable, so the answer does not
 * depend on what PATH names. */
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
  // behind when the scan raises.
  const [bare, graphed] = await Promise.allSettled([
    runInfo(root, []),
    runInfo(root, [entry]),
  ]);
  if (graphed.status === "rejected") throw graphed.reason;
  if (bare.status === "rejected") throw bare.reason;
  return pathsFromInfo(
    graphed.value,
    answered(bare.value.npmCache, "npm cache folder"),
  );
};
