import { type RestoreCliDeps, runRestoreCli } from "#scripts/restore-lib.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { inspectBackupZip, restoreFromZip } from "#shared/db/backup.ts";
import { readRecordedScriptCommit } from "#shared/update.ts";

type RestoreTaskDeps = Omit<RestoreCliDeps, keyof ScriptIo>;
type ScriptRunner = (
  run: (io: ScriptIo) => Promise<number>,
) => Promise<unknown>;
const RESTORE_ENV_KEYS = ["DB_URL", "DB_TOKEN"] as const;

const productionRestoreDeps = (): RestoreTaskDeps => ({
  inspectBackupZip,
  prompt,
  readFile: (path) => Deno.readFile(path),
  readRecordedScriptCommit,
  restoreFromZip,
});

export const runRestoreTask = async (
  fileEnv: Record<string, string>,
  setEnv: (key: string, value: string) => void,
  runScript: ScriptRunner,
  deps: RestoreTaskDeps = productionRestoreDeps(),
): Promise<void> => {
  for (const key of RESTORE_ENV_KEYS) {
    const value = fileEnv[key];
    if (value !== undefined) setEnv(key, value);
  }
  await runScript((io) => runRestoreCli({ ...deps, ...io }));
};
