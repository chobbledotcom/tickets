/* jscpd:ignore-start -- imports */
import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ModelDataSource } from "#scripts/verify-models/data.ts";
import { prepareChecks } from "#scripts/verify-models/jobs.ts";
import {
  type ModelLanguage,
  modelFileName,
  type VerificationModule,
} from "#scripts/verify-models/spec.ts";
import { withTempDir } from "#test-utils/files.ts";

/* jscpd:ignore-end */

const writeSources = async (
  modules: readonly VerificationModule[],
  root: string,
): Promise<void> => {
  for (const { language, module } of modules) {
    await Deno.writeTextFile(
      join(root, modelFileName(module, language)),
      sourceText[language](module),
    );
  }
};

/** The smallest source text that each reader accepts. */
const sourceText: Record<ModelLanguage, (module: string) => string> = {
  quint: (module) => `module ${module} {\n}\n`,
  tla: (module) => `---- MODULE ${module} ----\n====\n`,
};

const modelWith = (
  module: string,
  language: ModelLanguage,
  data: ModelDataSource,
  controlData: ModelDataSource,
): VerificationModule => ({
  context: [],
  controls: [{ data: controlData, name: "corrupt state", phase: "initial" }],
  data,
  kind: "model",
  language,
  module,
});

describe("model fact preparation", () => {
  test("finishes each database fixture before the next producer starts", () =>
    withTempDir(async (root) => {
      const seeded = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events: string[] = [];
      const model = (module: string): VerificationModule =>
        modelWith(
          module,
          "tla",
          async () => {
            events.push(`${module}:seed`);
            seeded.resolve();
            await release.promise;
            events.push(`${module}:read`);
            return "clean data";
          },
          () => {
            events.push(`${module}:corrupt`);
            return Promise.resolve("corrupted data");
          },
        );
      const modules: VerificationModule[] = [
        { context: [], kind: "helper", language: "tla", module: "SharedRules" },
        model("First"),
        model("Second"),
      ];
      await writeSources(modules, root);
      const complete = prepareChecks(modules, root, join(root, "checks"));
      await seeded.promise;
      expect(events).toEqual(["First:seed"]);
      release.resolve();
      await complete;
      expect(events).toEqual([
        "First:seed",
        "First:read",
        "First:corrupt",
        "Second:seed",
        "Second:read",
        "Second:corrupt",
      ]);
    }));

  test("propagates an extraction failure before any later producer runs", () =>
    withTempDir(async (root) => {
      const failure = new Error("The stored refund leg is absent.");
      const events: string[] = [];
      const model = (module: string): VerificationModule =>
        modelWith(
          module,
          "tla",
          () => {
            events.push(`${module}:read`);
            return Promise.resolve("clean data");
          },
          () => {
            events.push(`${module}:corrupt`);
            return Promise.reject(failure);
          },
        );
      const modules = [model("First"), model("Second")];
      await writeSources(modules, root);
      await expect(
        prepareChecks(modules, root, join(root, "checks")),
      ).rejects.toBe(failure);
      expect(events).toEqual(["First:read", "First:corrupt"]);
    }));

  test("writes each language with its own source and fact extension", () =>
    withTempDir(async (root) => {
      const modules: VerificationModule[] = [
        { context: [], kind: "helper", language: "tla", module: "SharedRules" },
        modelWith(
          "Laws",
          "quint",
          () => Promise.resolve("clean facts"),
          () => Promise.resolve("corrupt facts"),
        ),
      ];
      await writeSources(modules, root);
      const checks = await prepareChecks(modules, root, join(root, "checks"));
      expect(checks).toEqual([
        {
          directory: join(root, "checks", "Laws", "clean"),
          kind: "proof",
          language: "quint",
          module: "Laws",
          phase: "initial",
        },
        {
          directory: join(root, "checks", "Laws", "clean"),
          kind: "proof",
          language: "quint",
          module: "Laws",
          phase: "step",
        },
        {
          directory: join(root, "checks", "Laws", "control-1"),
          kind: "control",
          language: "quint",
          module: "Laws",
          name: "corrupt state",
          phase: "initial",
        },
      ]);
      expect(
        await Deno.readTextFile(
          join(root, "checks", "Laws", "clean", "Laws.qnt"),
        ),
      ).toBe("module Laws {\n}\n");
      expect(
        await Deno.readTextFile(
          join(root, "checks", "Laws", "clean", "SharedRules.tla"),
        ),
      ).toBe("---- MODULE SharedRules ----\n====\n");
      expect(
        await Deno.readTextFile(
          join(root, "checks", "Laws", "clean", "LawsData.qnt"),
        ),
      ).toBe("clean facts");
      expect(
        await Deno.readTextFile(
          join(root, "checks", "Laws", "control-1", "LawsData.qnt"),
        ),
      ).toBe("corrupt facts");
    }));
});
