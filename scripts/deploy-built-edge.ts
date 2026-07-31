#!/usr/bin/env -S deno run --allow-env=BUNNY_ACCESS_KEY,BUNNY_API_KEY --allow-read --allow-net=api.bunny.net

import { runDenoScript } from "#scripts/script-runner.ts";
import { runDeployBuiltEdge } from "./deploy-edge-lib.ts";
import { fetchText } from "./fetch-text.ts";

await runDenoScript((io) =>
  runDeployBuiltEdge({
    ...io,
    fetchText,
    readTextFile: (path) => Deno.readTextFile(path),
  }),
);
