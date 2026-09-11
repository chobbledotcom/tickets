import { join } from "node:path";
import * as v from "valibot";
import { removeIfPresent } from "#scripts/cleanup.ts";
import { projectRoot } from "#scripts/project-root.ts";
import {
  PRECOMMIT_STATUS_DIR,
  type PrecommitStatus,
  PrecommitStatusFilenameSchema,
  PrecommitStatusSchema,
} from "./status-schema.ts";

export interface PrecommitStatusProducer {
  runStep(name: string, run: () => Promise<boolean>): Promise<boolean>;
}

/** One invocation owns one record. Only complete JSON replaces the public file. */
export const runWithPrecommitStatus = async (
  run: (status: PrecommitStatusProducer) => Promise<number>,
  directory = join(projectRoot, PRECOMMIT_STATUS_DIR),
): Promise<number> => {
  const filename = v.parse(
    PrecommitStatusFilenameSchema,
    `${crypto.randomUUID()}.json`,
  );
  const path = join(directory, filename);
  const createdAt = new Date().toISOString();
  let current: PrecommitStatus = {
    createdAt,
    exitCode: null,
    pid: Deno.pid,
    state: "waiting",
    step: null,
    stepCompletedAt: null,
    updatedAt: createdAt,
  };
  const save = async (next: unknown): Promise<void> => {
    const record = v.parse(PrecommitStatusSchema, next);
    const temporary = await Deno.makeTempFile({
      dir: directory,
      suffix: ".tmp",
    });
    try {
      await Deno.writeTextFile(temporary, JSON.stringify(record));
      await Deno.rename(temporary, path);
      current = record;
    } finally {
      await removeIfPresent(temporary);
    }
  };
  const finish = (exitCode: number): Promise<void> =>
    save({
      ...current,
      exitCode,
      state: exitCode === 0 ? "passed" : "failed",
      updatedAt: new Date().toISOString(),
    });

  await Deno.mkdir(directory, { recursive: true });
  await save(current);
  try {
    const exitCode = await run({
      runStep: async (step, action): Promise<boolean> => {
        await save({
          ...current,
          state: "running",
          step,
          stepCompletedAt: null,
          updatedAt: new Date().toISOString(),
        });
        const passed = await action();
        const completedAt = new Date().toISOString();
        await save({
          ...current,
          stepCompletedAt: completedAt,
          updatedAt: completedAt,
        });
        return passed;
      },
    });
    await finish(exitCode);
    return exitCode;
  } catch (error) {
    await finish(1);
    throw error;
  }
};
