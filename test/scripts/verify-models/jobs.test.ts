import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ModelDataSource } from "#scripts/verify-models/data.ts";
import {
  modelNames,
  modulesFor,
  plannedChecks,
  prepareModel,
} from "#scripts/verify-models/jobs.ts";
import type {
  ModelControl,
  VerificationModule,
} from "#scripts/verify-models/spec.ts";
import { directoryNames, withTempDir } from "#test-utils/files.ts";

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

/** A planned check from its module, directory name, kind, phase, and the name
 * of its control. A proof has no name. */
type PlannedRow = readonly [
  module: string,
  variant: string,
  kind: string,
  phase: string,
  name?: string,
];
const plannedIn = (work: string, rows: readonly PlannedRow[]) =>
  rows.map(([module, variant, kind, phase, name]) => ({
    directory: join(work, module, variant),
    kind,
    module,
    phase,
    ...(name === undefined ? {} : { name }),
  }));

const modelWith = (
  module: string,
  data: ModelDataSource,
  controls: readonly [ModelDataSource, ...ModelDataSource[]],
  reduced: readonly ModelControl[] = [],
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
      ...reduced,
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
      const corrupt =
        (name: string): ModelDataSource =>
        () => {
          events.push(name);
          return Promise.resolve("corrupted data");
        };
      const modules: VerificationModule[] = [
        { context: [], kind: "helper", module: "SharedRules" },
        modelWith("First", async () => {
          events.push("seed");
          seeded.resolve();
          await release.promise;
          events.push("read");
          return "clean data";
        }, [corrupt("corrupt one"), corrupt("corrupt two")]),
      ];
      await writeSources(modules, root);
      const complete = prepareModel(
        modules,
        "First",
        root,
        join(root, "checks"),
      );
      await seeded.promise;
      expect(events).toEqual(["seed"]);
      release.resolve();
      await complete;
      expect(events).toEqual(["seed", "read", "corrupt one", "corrupt two"]);
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
      const modules: VerificationModule[] = [
        { context: [], kind: "helper", module: "SharedRules" },
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
      const checks = plannedChecks(modules, work);
      expect(checks).toEqual(
        plannedIn(work, [
          ["First", "initial", "proof", "initial"],
          ["First", "step", "proof", "step"],
          ["First", "control-1", "control", "initial", "corrupt state 1"],
          ["First", "control-2", "control", "initial", "corrupt state 2"],
          ["Second", "initial", "proof", "initial"],
          ["Second", "step", "proof", "step"],
          ["Second", "control-1", "control", "initial", "corrupt state 1"],
        ]),
      );
      expect([...reads]).toEqual([]);

      await prepareModel(modules, "First", root, work);
      expect([...reads]).toEqual([["First", 1]]);
      const data = (variant: string): Promise<string> =>
        Deno.readTextFile(join(work, "First", variant, "FirstData.tla"));
      for (const variant of ["initial", "step", "control-1", "control-2"]) {
        expect(await directoryNames(join(work, "First", variant))).toEqual([
          "First.tla",
          "FirstData.tla",
          "SharedRules.tla",
        ]);
      }
      expect(
        await Deno.readTextFile(join(work, "First", "step", "First.tla")),
      ).toBe("---- MODULE First ----\n====\n");
      expect(
        await Promise.all(
          ["initial", "step", "control-1", "control-2"].map(data),
        ),
      ).toEqual([
        "clean data",
        "clean data",
        "corrupted data one",
        "corrupted data two",
      ]);
    }));

  test("checks the scope of a reduced control before that control", () =>
    withTempDir(async (root) => {
      const modules: VerificationModule[] = [
        modelWith(
          "First",
          () => Promise.resolve("clean data"),
          [() => Promise.resolve("whole control data")],
          [
            {
              data: () => Promise.resolve("kept facts with the fault"),
              name: "one wrong amount",
              phase: "step",
              scope: () => Promise.resolve("kept facts"),
            },
          ],
        ),
      ];
      await writeSources(modules, root);
      const work = join(root, "checks");
      expect(plannedChecks(modules, work).slice(3)).toEqual(
        plannedIn(work, [
          ["First", "control-2-scope", "scope", "step", "one wrong amount"],
          ["First", "control-2", "control", "step", "one wrong amount"],
        ]),
      );
      await prepareModel(modules, "First", root, work);
      const data = (variant: string): Promise<string> =>
        Deno.readTextFile(join(work, "First", variant, "FirstData.tla"));
      expect(
        await Promise.all(["control-2-scope", "control-2"].map(data)),
      ).toEqual(["kept facts", "kept facts with the fault"]);
    }));

  test("propagates an extraction failure before any later producer runs", () =>
    withTempDir(async (root) => {
      const failure = new Error("The stored refund leg is absent.");
      const events: string[] = [];
      const modules = [
        modelWith("First", () => {
          events.push("read");
          return Promise.resolve("clean data");
        }, [
          () => {
            events.push("corrupt one");
            return Promise.reject(failure);
          },
          () => {
            events.push("corrupt two");
            return Promise.resolve("corrupted data");
          },
        ]),
      ];
      await writeSources(modules, root);
      await expect(
        prepareModel(modules, "First", root, join(root, "checks")),
      ).rejects.toBe(failure);
      expect(events).toEqual(["read", "corrupt one"]);
    }));

  test("refuses a name that no registered model has", () =>
    withTempDir(async (root) => {
      const modules: VerificationModule[] = [
        { context: [], kind: "helper", module: "SharedRules" },
      ];
      await writeSources(modules, root);
      await expect(
        prepareModel(modules, "SharedRules", root, join(root, "checks")),
      ).rejects.toThrow("No registered model has the name SharedRules.");
    }));
});

describe("model selection", () => {
  const helper: VerificationModule = {
    context: [],
    kind: "helper",
    module: "SharedRules",
  };
  const first = modelWith("First", () => Promise.resolve("clean"), [
    () => Promise.resolve("corrupt"),
  ]);
  const second = modelWith("Second", () => Promise.resolve("clean"), [
    () => Promise.resolve("corrupt"),
  ]);
  const modules = [helper, first, second];

  test("lists the models and leaves out helpers", () => {
    expect(modelNames(modules)).toEqual(["First", "Second"]);
  });

  test("keeps every module when no model is named", () => {
    expect(modulesFor(modules, undefined)).toEqual(modules);
  });

  test("keeps the helpers and the one named model", () => {
    expect(modulesFor(modules, "Second")).toEqual([helper, second]);
  });

  test("rejects a name that no model has", () => {
    expect(() => modulesFor(modules, "SharedRules")).toThrow(
      "No registered model has the name SharedRules.",
    );
  });
});
