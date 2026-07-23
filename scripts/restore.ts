#!/usr/bin/env -S deno run --allow-env --allow-read --allow-write --allow-net --allow-sys --allow-ffi

import { load } from "@std/dotenv";
import { runDenoScript } from "#scripts/script-runner.ts";
import { runRestoreTask } from "#src/restore.ts";

await runRestoreTask(
  await load(),
  (key, value) =>
    value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value),
  runDenoScript,
);
