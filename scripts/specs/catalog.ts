import { isAbsolute, join, relative } from "node:path";
import * as v from "valibot";
import { projectRoot } from "#scripts/project-root.ts";
import { validateSpecSources } from "./profile.ts";
import {
  type SpecCatalog,
  type SpecRegistry,
  SpecRegistrySchema,
  type SpecSource,
} from "./types.ts";

const DEFAULT_SPEC_PATH = join(projectRoot, "specs");
const OWNER_PATH = join(DEFAULT_SPEC_PATH, "owners.json");

const BASE_REGISTRY: Omit<SpecRegistry, "owners"> = {
  actors: ["customer", "organiser"],
  editions: ["managed", "self-hosted"],
  risks: ["high", "medium", "low"],
  surfaces: ["admin", "return", "webhook"],
};

const OwnerFileSchema = v.pick(SpecRegistrySchema, ["owners"]);

const featurePathsUnder = async (path: string): Promise<string[]> => {
  const stat = await Deno.stat(path);
  if (stat.isFile) return path.endsWith(".feature") ? [path] : [];
  const paths: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) paths.push(...(await featurePathsUnder(child)));
    else if (entry.isFile && child.endsWith(".feature")) paths.push(child);
  }
  return paths;
};

export const collectFeaturePaths = async (
  requested: string[] = [DEFAULT_SPEC_PATH],
): Promise<string[]> => {
  const collected = (
    await Promise.all(
      requested.map((path) =>
        featurePathsUnder(isAbsolute(path) ? path : join(projectRoot, path)),
      ),
    )
  ).flat();
  return [...new Set(collected)].sort();
};

export const parseSpecOwners = (input: unknown): string[] =>
  v.parse(OwnerFileSchema, input).owners;

const loadRegistry = async (): Promise<SpecRegistry> =>
  v.parse(SpecRegistrySchema, {
    ...BASE_REGISTRY,
    owners: parseSpecOwners(JSON.parse(await Deno.readTextFile(OWNER_PATH))),
  });

const sourceFromPath = async (path: string): Promise<SpecSource> => ({
  data: await Deno.readTextFile(path),
  uri: relative(projectRoot, path).replaceAll("\\", "/"),
});

export const readSpecCatalog = async (
  requested: string[] = [DEFAULT_SPEC_PATH],
): Promise<SpecCatalog> => {
  const paths = await collectFeaturePaths(requested);
  if (paths.length === 0) throw new Error("No Cucumber Feature files found");
  return validateSpecSources(
    await Promise.all(paths.map(sourceFromPath)),
    await loadRegistry(),
  );
};
