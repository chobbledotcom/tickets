import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { projectRoot } from "#scripts/project-root.ts";
import { MODELS } from "#scripts/verify-models/registry.ts";

/** The shared rules module the models extend. The checker loads it beside
 *  every model, so it is not a model of its own. */
const RULES_MODULE = "ModelRules";

/** The checker modules the verification directory declares. */
const declaredModules = async (): Promise<string[]> => {
  const modules: string[] = [];
  for await (const entry of Deno.readDir(join(projectRoot, "verification"))) {
    if (entry.isFile && entry.name.endsWith(".tla")) {
      modules.push(entry.name.slice(0, -".tla".length));
    }
  }
  return modules.sort();
};

describe("the model registry", () => {
  test("registers exactly the model files in verification/", async () => {
    const declared = (await declaredModules()).filter(
      (name) => name !== RULES_MODULE,
    );
    expect(MODELS.map((model) => model.module).sort(), "model modules").toEqual(
      declared,
    );
  });
});
