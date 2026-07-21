import type { BuildOptions } from "esbuild";
import { runCleanups } from "#scripts/cleanup.ts";
import { rethrowUnlessNotFound } from "#scripts/not-found.ts";

export interface StaticBundle {
  label: string;
  options: BuildOptions & { outfile: string };
}

export interface StaticAssetBuild {
  affected(file: string): StaticBundle[];
  dispose(): Promise<void>;
  rebuild(bundles: StaticBundle[]): Promise<boolean>;
  restore(bundles: StaticBundle[]): Promise<void>;
}

export interface StaticBundleContext<Result = unknown> {
  context: {
    dispose(): Promise<void>;
    rebuild(): Promise<Result>;
  };
}

export interface BuiltStaticBundle extends StaticBundleContext {
  baseline: Uint8Array;
  bundle: StaticBundle;
  inputs: string[];
}

export interface StaticAssetFiles {
  resolve(file: string): string;
  stop(): void;
  write(file: string, contents: Uint8Array): Promise<void>;
}

export const fileExists = async (file: string): Promise<boolean> => {
  try {
    await Deno.stat(file);
    return true;
  } catch (error) {
    rethrowUnlessNotFound(error);
    return false;
  }
};

export const disposeStaticBundleContexts = (
  bundles: StaticBundleContext[],
): Promise<void> =>
  runCleanups(
    bundles.map(
      ({ context }) =>
        () =>
          context.dispose(),
    ),
  );

export const settleAll = async (tasks: Promise<unknown>[]): Promise<void> => {
  const results = await Promise.allSettled(tasks);
  const failures: Array<() => Promise<never>> = [];
  for (const result of results) {
    if (result.status === "rejected") {
      failures.push(() => Promise.reject(result.reason));
    }
  }
  await runCleanups(failures);
};

export const rebuildStaticBundleContexts = async <Result>(
  bundles: StaticBundleContext<Result>[],
): Promise<Result[]> => {
  const rebuilds = bundles.map(({ context }) => context.rebuild());
  await settleAll(rebuilds);
  return await Promise.all(rebuilds);
};

const builtBundle = (
  bundles: Map<StaticBundle, BuiltStaticBundle>,
  bundle: StaticBundle,
): BuiltStaticBundle => {
  const built = bundles.get(bundle);
  if (!built) throw new Error(`Static bundle was not built: ${bundle.label}`);
  return built;
};

const buildGraph = (
  bundles: BuiltStaticBundle[],
  resolve: (file: string) => string,
): Map<string, StaticBundle[]> => {
  const graph = new Map<string, StaticBundle[]>();
  for (const built of bundles) {
    for (const input of built.inputs) {
      const file = resolve(input);
      const affected = graph.get(file);
      if (affected) affected.push(built.bundle);
      else graph.set(file, [built.bundle]);
    }
  }
  return graph;
};

export const createStaticAssetBuild = (
  bundles: BuiltStaticBundle[],
  files: StaticAssetFiles,
): StaticAssetBuild => {
  const graph = buildGraph(bundles, files.resolve);
  const byBundle = new Map(bundles.map((built) => [built.bundle, built]));
  return {
    affected: (file) => graph.get(files.resolve(file)) ?? [],
    dispose: () =>
      runCleanups([
        () => disposeStaticBundleContexts(bundles),
        () => files.stop(),
      ]),
    rebuild: async (affected) => {
      const builds = affected.map((bundle) => builtBundle(byBundle, bundle));
      try {
        await rebuildStaticBundleContexts(builds);
        return true;
      } catch {
        return false;
      }
    },
    restore: (affected) => {
      const writes = affected.map((bundle) => {
        const built = builtBundle(byBundle, bundle);
        return files.write(built.bundle.options.outfile, built.baseline);
      });
      return settleAll(writes);
    },
  };
};
