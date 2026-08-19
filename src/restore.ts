import { inspectBackupZip, restoreFromZip } from "#db/backup.ts";
import { type RestoreCliDeps, runRestoreCli } from "#scripts/restore-lib.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { readRecordedScriptCommit } from "#shared/update.ts";

type RestoreTaskDeps = Omit<RestoreCliDeps, keyof ScriptIo>;
type ScriptRunner = (
  run: (io: ScriptIo) => Promise<number>,
) => Promise<unknown>;
const RESTORE_ENV_KEYS = ["DB_ENCRYPTION_KEY", "DB_TOKEN", "DB_URL"] as const;

const productionRestoreDeps = (): RestoreTaskDeps => ({
  inspectBackupZip,
  prompt,
  readFile: (path) => Deno.readFile(path),
  readRecordedScriptCommit,
  restoreFromZip,
});

export const runRestoreTask = async (
  fileEnv: Record<string, string>,
  setEnv: (key: string, value: string | undefined) => void,
  runScript: ScriptRunner,
  deps: RestoreTaskDeps = productionRestoreDeps(),
): Promise<void> => {
  for (const key of RESTORE_ENV_KEYS) {
    setEnv(key, fileEnv[key]);
  }
  await runScript((io) => runRestoreCli({ ...deps, ...io }));
};
