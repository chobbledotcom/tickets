#!/usr/bin/env -S deno run --env-file --allow-env --allow-read --allow-write --allow-run --allow-net

import { fromFileUrl } from "@std/path";
import { runDenoScript } from "#scripts/script-runner.ts";
import { runDeployEdge } from "./deploy-edge-lib.ts";
import { fetchText } from "./fetch-text.ts";
import { runBuildEdge } from "./run-build-edge.ts";

const repoRoot = fromFileUrl(new URL("..", import.meta.url));
const bundlePath = fromFileUrl(new URL("../bunny-script.ts", import.meta.url));

await runDenoScript((io) =>
  runDeployEdge({
    ...io,
    bundlePath,
    cwd: repoRoot,
    fetchText,
    readTextFile: (path) => Deno.readTextFile(path),
    runBuildEdge,
  }),
);
