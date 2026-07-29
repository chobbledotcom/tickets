import { isAbsolute, join } from "node:path";
import * as v from "valibot";
import { relativeToProject } from "#scripts/path.ts";
import { projectRoot } from "#scripts/project-root.ts";
import { isFeaturePath } from "./paths.ts";
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
  // An editor is an organiser-side helper who may write listings and nothing
  // else, so a story about what they can reach has a different actor from one
  // about the person who runs the site.
  actors: ["customer", "editor", "organiser"],
  editions: ["managed", "self-hosted"],
  risks: ["high", "medium", "low"],
  // "public" is a page a customer opens themselves, without signing in and
  // without arriving back from a payment provider: the link they pay an
  // outstanding balance from is one.
  surfaces: ["admin", "public", "return", "webhook"],
};

const OwnerFileSchema = v.pick(SpecRegistrySchema, ["owners"]);

const featurePathsUnder = async (path: string): Promise<string[]> => {
  const stat = await Deno.stat(path);
  if (stat.isFile) return isFeaturePath(path) ? [path] : [];
  const paths: string[] = [];
  for await (const entry of Deno.readDir(path)) {
    const child = join(path, entry.name);
    if (entry.isDirectory) paths.push(...(await featurePathsUnder(child)));
    else if (entry.isFile && isFeaturePath(child)) paths.push(child);
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
  uri: relativeToProject(path),
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
