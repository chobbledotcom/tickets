import type { BuildOptions } from "esbuild";
import { runCleanups } from "../cleanup.ts";

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

export interface StaticBundleContext {
  context: {
    dispose(): Promise<void>;
    rebuild(): Promise<unknown>;
  };
}

export interface BuiltStaticBundle extends StaticBundleContext {
  baseline: Uint8Array;
  bundle: StaticBundle;
  inputs: string[];
}

export interface StaticAssetFiles {
  resolve(file: string): string;
  write(file: string, contents: Uint8Array): Promise<void>;
}

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
    dispose: () => disposeStaticBundleContexts(bundles),
    rebuild: async (affected) => {
      const builds = affected.map((bundle) => builtBundle(byBundle, bundle));
      try {
        await Promise.all(builds.map(({ context }) => context.rebuild()));
        return true;
      } catch {
        return false;
      }
    },
    restore: (affected) =>
      Promise.all(
        affected.map((bundle) => {
          const built = builtBundle(byBundle, bundle);
          return files.write(built.bundle.options.outfile, built.baseline);
        }),
      ).then(() => {}),
  };
};
