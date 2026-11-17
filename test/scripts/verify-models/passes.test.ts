import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { ModelCheck } from "#scripts/verify-models/jobs.ts";
import {
  checkKey,
  forgetOldPasses,
  passStore,
} from "#scripts/verify-models/passes.ts";
import { requireValue } from "#shared/required-value.ts";
import { directoryNames, withTempDir } from "#test-utils/files.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** One work directory with a model, its data, and one file the checker wrote. */
const writeCheck = async (
  root: string,
  name: string,
  data: string,
): Promise<ModelCheck> => {
  const directory = join(root, name);
  await Deno.mkdir(directory);
  await Deno.writeTextFile(join(directory, "Model.tla"), "model");
  await Deno.writeTextFile(join(directory, "ModelData.tla"), data);
  await Deno.writeTextFile(join(directory, "run.log"), name);
  return { directory, kind: "proof", module: "Model", phase: "initial" };
};

/** A check with a recorded pass that a run last used some days ago. */
const passUsed = async (
  root: string,
  name: string,
  now: number,
  days: number,
): Promise<{ check: ModelCheck; pass: string }> => {
  const directory = join(root, "passes");
  const check = await writeCheck(root, name, `${name} data`);
  const store = await passStore(directory, "0.62.1");
  const before = new Set(await directoryNames(directory));
  await store.record(check);
  const pass = requireValue(
    (await directoryNames(directory)).find((name) => !before.has(name)),
    "The pass was not recorded.",
  );
  const used = new Date(now - days * DAY_MS);
  await Deno.utime(join(directory, pass), used, used);
  return { check, pass };
};

describe("recorded model check passes", () => {
  test("names a check by its inputs, not by its work directory", () =>
    withTempDir(async (root) => {
      const first = await writeCheck(root, "first", "clean data");
      const second = await writeCheck(root, "second", "clean data");
      const key = await checkKey(first, "0.62.1", "rule");
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(await checkKey(second, "0.62.1", "rule")).toBe(key);
    }));

  test("gives another name when any input that decides the verdict changes", () =>
    withTempDir(async (root) => {
      const check = await writeCheck(root, "clean", "clean data");
      const changedData = await writeCheck(root, "data", "corrupted data");
      const extraFile = await writeCheck(root, "extra", "clean data");
      await Deno.writeTextFile(join(extraFile.directory, "Rules.tla"), "");
      const renamed = await writeCheck(root, "renamed", "clean data");
      await Deno.rename(
        join(renamed.directory, "Model.tla"),
        join(renamed.directory, "Other.tla"),
      );
      const keys = await Promise.all([
        checkKey(check, "0.62.1", "rule"),
        checkKey(check, "0.63.0", "rule"),
        checkKey(check, "0.62.1", "other rule"),
        checkKey({ ...check, phase: "step" }, "0.62.1", "rule"),
        checkKey(
          { ...check, kind: "control", name: "lost money" },
          "0.62.1",
          "rule",
        ),
        checkKey(changedData, "0.62.1", "rule"),
        checkKey(extraFile, "0.62.1", "rule"),
        checkKey(renamed, "0.62.1", "rule"),
      ]);
      expect(new Set(keys).size).toBe(keys.length);
    }));

  test("knows a pass only after its record, and keeps it for a later store", () =>
    withTempDir(async (root) => {
      const directory = join(root, "passes", "nested");
      const clean = await writeCheck(root, "clean", "clean data");
      const corrupted = await writeCheck(root, "corrupted", "corrupted data");
      const store = await passStore(directory, "0.62.1");
      expect(await store.known(clean)).toBe(false);
      await store.record(clean);
      const names = await directoryNames(directory);
      expect(names.length).toBe(1);
      expect(names[0]).toMatch(/^[0-9a-f]{64}$/);

      const later = await passStore(directory, "0.62.1");
      expect(await later.known(clean)).toBe(true);
      expect(await later.known(corrupted)).toBe(false);
      const newChecker = await passStore(directory, "0.63.0");
      expect(await newChecker.known(clean)).toBe(false);
    }));

  test("removes only a pass that no run used for more than 30 days", () =>
    withTempDir(async (root) => {
      const directory = join(root, "passes");
      const now = Date.now();
      await passUsed(root, "unused", now, 31);
      const kept = [
        await passUsed(root, "used", now, 31),
        await passUsed(root, "edge", now, 30),
        await passUsed(root, "fresh", now, 0),
      ];
      const later = await passStore(directory, "0.62.1");
      expect(await later.known(kept[0]!.check)).toBe(true);
      await forgetOldPasses(directory, now);
      expect(await directoryNames(directory)).toEqual(
        kept.map(({ pass }) => pass).sort(),
      );
    }));
});
