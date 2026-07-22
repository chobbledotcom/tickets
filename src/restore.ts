#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

import { load } from "@std/dotenv";
import { applyRestoreFileEnv, runRestoreCli } from "#scripts/restore-lib.ts";
import { runDenoScript } from "#scripts/script-runner.ts";
import { inspectBackupZip, restoreFromZip } from "#shared/db/backup.ts";
import { readRecordedScriptCommit } from "#shared/update.ts";

applyRestoreFileEnv(await load(), (key, value) => Deno.env.set(key, value));

await runDenoScript((io) =>
  runRestoreCli({
    ...io,
    inspectBackupZip,
    prompt,
    readFile: (path) => Deno.readFile(path),
    readRecordedScriptCommit,
    restoreFromZip,
  }),
);
