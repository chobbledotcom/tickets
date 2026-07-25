#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

import { createClient } from "@libsql/client";
import { promptSecret } from "@std/cli/prompt-secret";
import { load } from "@std/dotenv";
import { createDatabaseSnapshot } from "#scripts/database-snapshot-lib.ts";
import { runDenoScript } from "#scripts/script-runner.ts";
import { onTerminationSignals } from "#scripts/termination-signals.ts";
import {
  uploadTursoDatabaseFile,
  verifyTursoUploadFile,
} from "#scripts/turso-migration-file.ts";
import { runMigrateTursoCli } from "#scripts/turso-migration-lib.ts";
import { createTursoApi } from "#shared/turso-api.ts";

const fileEnv = await load();
const interruption = new AbortController();
onTerminationSignals(() => {
  if (interruption.signal.aborted) Deno.exit(130);
  interruption.abort(new Error("Migration interrupted"));
});
await runDenoScript((io) =>
  runMigrateTursoCli({
    ...io,
    createApi: createTursoApi,
    createSnapshot: (request, writeProgress, signal) =>
      createDatabaseSnapshot(request, createClient, writeProgress, signal),
    getEnv: (key) => fileEnv[key] ?? io.getEnv(key),
    makeTempDir: () => Deno.makeTempDir({ prefix: "tickets-turso-migration-" }),
    prompt,
    promptSecret: (message) => promptSecret(message, { mask: "" }),
    removeTempDir: (path) => Deno.remove(path, { recursive: true }),
    signal: interruption.signal,
    uploadDatabaseFile: uploadTursoDatabaseFile,
    verifyUploadFile: (path) => verifyTursoUploadFile(path, createClient),
  }),
);
