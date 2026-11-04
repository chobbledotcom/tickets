import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ModelDataSource } from "#scripts/verify-models/data.ts";
import { prepareChecks } from "#scripts/verify-models/jobs.ts";
import type {
  ModelControl,
  VerificationModule,
} from "#scripts/verify-models/spec.ts";
import { withTempDir } from "#test-utils/files.ts";

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
  controls: readonly [ModelDataSource, ...ModelDataSource[]],
): VerificationModule => {
  const control = (source: ModelDataSource, index: number): ModelControl => ({
    data: source,
    name: `corrupt state ${index + 1}`,
    phase: "initial",
  });
  const [first, ...rest] = controls;
  return {
    context: [],
    controls: [
      control(first, 0),
      ...rest.map((source, index) => control(source, index + 1)),
    ],
    data,
    kind: "model",
    module,
  };
};

describe("model fact preparation", () => {
  test("finishes each database fixture before the next producer starts", () =>
    withTempDir(async (root) => {
      const seeded = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events: string[] = [];
      const model = (module: string): VerificationModule =>
        modelWith(module, async () => {
          events.push(`${module}:seed`);
          seeded.resolve();
          await release.promise;
          events.push(`${module}:read`);
          return "clean data";
        }, [
          () => {
            events.push(`${module}:corrupt`);
            return Promise.resolve("corrupted data");
          },
        ]);
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

  test("gives every check a work directory of its own", () =>
    withTempDir(async (root) => {
      const reads = new Map<string, number>();
      const readClean =
        (module: string): ModelDataSource =>
        async () => {
          reads.set(module, (reads.get(module) ?? 0) + 1);
          return "clean data";
        };
      const modules = [
        modelWith("First", readClean("First"), [
          () => Promise.resolve("corrupted data one"),
          () => Promise.resolve("corrupted data two"),
        ]),
        modelWith("Second", readClean("Second"), [
          () => Promise.resolve("corrupted data three"),
        ]),
      ];
      await writeSources(modules, root);
      const work = join(root, "checks");
      const checks = await prepareChecks(modules, root, work);
      expect([...reads]).toEqual([
        ["First", 1],
        ["Second", 1],
      ]);
      const directories = checks.map((check) => check.directory);
      expect(directories).toEqual([
        join(work, "First", "initial"),
        join(work, "First", "step"),
        join(work, "First", "control-1"),
        join(work, "First", "control-2"),
        join(work, "Second", "initial"),
        join(work, "Second", "step"),
        join(work, "Second", "control-1"),
      ]);
      expect(new Set(directories).size).toBe(checks.length);
      const proofInputs: string[] = [];
      for (const phase of ["initial", "step"]) {
        const directory = join(work, "First", phase);
        expect(await Deno.readTextFile(join(directory, "First.tla"))).toBe(
          "---- MODULE First ----\n====\n",
        );
        proofInputs.push(
          await Deno.readTextFile(join(directory, "FirstData.tla")),
        );
      }
      expect(proofInputs).toEqual(["clean data", "clean data"]);
    }));

  test("propagates an extraction failure before any later producer runs", () =>
    withTempDir(async (root) => {
      const failure = new Error("The stored refund leg is absent.");
      const events: string[] = [];
      const model = (module: string): VerificationModule =>
        modelWith(module, () => {
          events.push(`${module}:read`);
          return Promise.resolve("clean data");
        }, [
          () => {
            events.push(`${module}:corrupt`);
            return Promise.reject(failure);
          },
        ]);
      const modules = [model("First"), model("Second")];
      await writeSources(modules, root);
      await expect(
        prepareChecks(modules, root, join(root, "checks")),
      ).rejects.toBe(failure);
      expect(events).toEqual(["First:read", "First:corrupt"]);
    }));
});
