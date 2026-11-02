/* jscpd:ignore-start -- imports */
import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ModelDataSource } from "#scripts/verify-models/data.ts";
import { prepareChecks } from "#scripts/verify-models/jobs.ts";
import type { VerificationModule } from "#scripts/verify-models/spec.ts";
import { withTempDir } from "#test-utils/files.ts";

/* jscpd:ignore-end */

const writeSources = async (
  modules: readonly VerificationModule[],
  root: string,
): Promise<void> => {
  for (const { module } of modules) {
    await Deno.writeTextFile(
      join(root, `${module}.tla`),
      `---- MODULE ${module} ----\n====\n`,
    );
  }
};

const modelWith = (
  module: string,
  data: ModelDataSource,
  controlData: ModelDataSource,
): VerificationModule => ({
  context: [],
  controls: [{ data: controlData, name: "corrupt state", phase: "initial" }],
  data,
  kind: "model",
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
        { context: [], kind: "helper", module: "SharedRules" },
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
});
