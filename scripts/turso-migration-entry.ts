import { createClient } from "@libsql/client";
import { promptSecret } from "@std/cli/prompt-secret";
import { load } from "@std/dotenv";
import { createDatabaseSnapshot } from "#scripts/database-snapshot-lib.ts";
import type { ScriptIo } from "#scripts/script-runner.ts";
import { onTerminationSignals } from "#scripts/termination-signals.ts";
import {
  uploadTursoDatabaseFile,
  verifyTursoUploadFile,
} from "#scripts/turso-migration-file.ts";
import type { TursoMigrationDeps } from "#scripts/turso-migration-steps.ts";
import { createTursoApi } from "#shared/turso-api.ts";

/** Stop on the first Ctrl-C, and quit outright on the second. */
export const migrationInterruption = (): AbortSignal => {
  const interruption = new AbortController();
  onTerminationSignals(() => {
    if (interruption.signal.aborted) Deno.exit(130);
    interruption.abort(new Error("Migration interrupted"));
  });
  return interruption.signal;
};

/**
 * The real world a migration task runs in: `.env` settings, hidden prompts,
 * temporary files, libSQL, and the Turso API.
 */
export const tursoMigrationDeps = async (
  io: ScriptIo,
  signal: AbortSignal,
  tempDirPrefix: string,
): Promise<TursoMigrationDeps> => {
  const fileEnv = await load();
  return {
    ...io,
    createApi: (token, apiSignal) => createTursoApi(token, apiSignal),
    createSnapshot: (request, writeProgress, snapshotSignal) =>
      createDatabaseSnapshot(
        request,
        createClient,
        writeProgress,
        snapshotSignal,
      ),
    getEnv: (key) => fileEnv[key] ?? io.getEnv(key),
    makeTempDir: () => Deno.makeTempDir({ prefix: tempDirPrefix }),
    prompt,
    promptSecret: (message) => promptSecret(message, { mask: "" }),
    removeTempDir: (path) => Deno.remove(path, { recursive: true }),
    signal,
    uploadDatabaseFile: uploadTursoDatabaseFile,
    verifyUploadFile: (path, verifySignal) =>
      verifyTursoUploadFile(path, createClient, verifySignal),
  };
};
