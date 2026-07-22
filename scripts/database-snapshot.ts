#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

import { createClient } from "@libsql/client";
import { resolve } from "@std/path";
import {
  createDatabaseSnapshot,
  parseSnapshotArgs,
  readSnapshotRequestFromEnvFile,
  SNAPSHOT_USAGE,
} from "#scripts/database-snapshot-lib.ts";
import { createSnapshotProgressOutput } from "#scripts/database-snapshot-output.ts";
import { formatBytes, formatMs } from "#shared/limits.ts";

const encoder = new TextEncoder();

const options = parseSnapshotArgs(Deno.args);
if (options === null) {
  console.log(SNAPSHOT_USAGE);
} else {
  const startedAt = performance.now();
  const request = await readSnapshotRequestFromEnvFile(options);
  console.log(
    `Database snapshot\n  Source: ${new URL(request.dbUrl).host}\n  Output: ${resolve(request.outputPath)}\n`,
  );
  const progress = createSnapshotProgressOutput({
    terminal: Deno.stdout.isTerminal(),
    write: (text) => {
      Deno.stdout.writeSync(encoder.encode(text));
    },
  });
  let outputPath: string;
  try {
    outputPath = await createDatabaseSnapshot(
      request,
      createClient,
      progress.report,
    );
  } finally {
    progress.stop();
  }
  const size = (await Deno.stat(outputPath)).size;
  console.log(
    `\nSnapshot ready\n  File: ${outputPath}\n  Size: ${formatBytes(size)}\n  Time: ${formatMs(Math.round(performance.now() - startedAt))}`,
  );
}
