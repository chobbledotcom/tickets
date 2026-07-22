#!/usr/bin/env -S deno run --env-file --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

import { createClient } from "@libsql/client";
import {
  createDatabaseSnapshot,
  parseSnapshotArgs,
  readSnapshotRequest,
  SNAPSHOT_USAGE,
} from "#scripts/database-snapshot-lib.ts";

const options = parseSnapshotArgs(Deno.args);
if (options === null) {
  console.log(SNAPSHOT_USAGE);
} else {
  const outputPath = await createDatabaseSnapshot(
    readSnapshotRequest(options),
    createClient,
  );
  console.log(`Database snapshot written to ${outputPath}`);
}
