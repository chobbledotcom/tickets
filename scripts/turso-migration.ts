#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

import { runDenoScript } from "#scripts/script-runner.ts";
import {
  migrationInterruption,
  tursoMigrationDeps,
} from "#scripts/turso-migration-entry.ts";
import { runMigrateTursoCli } from "#scripts/turso-migration-lib.ts";

const signal = migrationInterruption();

await runDenoScript(async (io) =>
  runMigrateTursoCli(
    await tursoMigrationDeps(io, signal, "tickets-turso-migration-"),
  ),
);
