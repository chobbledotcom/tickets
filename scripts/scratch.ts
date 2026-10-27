import { join } from "node:path";
import { projectRoot } from "#scripts/project-root.ts";

export const makeScratchDir = async (prefix: string): Promise<string> => {
  const dir = join(projectRoot, ".scratch");
  await Deno.mkdir(dir, { recursive: true });
  return Deno.makeTempDir({ dir, prefix });
};
