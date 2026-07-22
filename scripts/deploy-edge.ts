#!/usr/bin/env -S deno run --env-file --allow-env --allow-read --allow-write --allow-run --allow-net

import { fromFileUrl } from "@std/path";
import { runDenoScript } from "#scripts/script-runner.ts";
import { type FetchTextResult, runDeployEdge } from "./deploy-edge-lib.ts";
import { runBuildEdge } from "./run-build-edge.ts";

const repoRoot = fromFileUrl(new URL("..", import.meta.url));
const bundlePath = fromFileUrl(new URL("../bunny-script.ts", import.meta.url));

const fetchText = async (
  url: string,
  init: RequestInit,
): Promise<FetchTextResult> => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
};

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
