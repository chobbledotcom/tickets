/**
 * Cold-start benchmark 1: what does *loading* the production bundle cost?
 *
 * Bunny Edge Scripting (and Deno Deploy) pay this on every isolate cold
 * start: parse + compile + top-level evaluation of the single-file bundle.
 * This benchmark builds the production pipeline's bundle for the shared
 * request handler (`src/serve-app.ts` — the edge entry minus the BunnySDK
 * serve call, so importing it does not open a listener), plus variants with
 * the big inlined string payloads emptied, and times a fresh `deno run`
 * import of each:
 *
 *   hello        — a two-line handler; the Deno-process floor.
 *   full         — the real bundle, byte-for-byte the production pipeline.
 *   no-wasm      — WASM codec base64 blobs emptied (~1.4MB of the bundle).
 *   no-big-strings — WASM blobs AND inlined client JS/CSS assets emptied.
 *
 * Each run is a fresh process with `--no-code-cache`, so V8 cannot reuse a
 * compile from the previous run (a cold edge isolate cannot either). The
 * "request" mode also serves /robots.txt once — a static route that never
 * touches the database — to time the lazy module evaluation plus boot checks
 * a first request pays after import.
 *
 * Run with: deno run -A scripts/bench/cold-start/bundle-load.ts [--skip-build]
 */

import { encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";
import { buildEdgeBundle } from "../../edge-bundle-lib.ts";
import { benchChildEnv } from "./child-env.ts";
import {
  median,
  stripBase64Payloads,
  stripLongStrings,
  strippedChars,
} from "./strip-lib.ts";

const OUT_DIR = "./dist/bench-cold-start";
const FULL = `${OUT_DIR}/serve-app.js`;
const LAZY = `${OUT_DIR}/lazy-entry.js`;
const NO_WASM = `${OUT_DIR}/serve-app-no-wasm.js`;
const NO_BIG_STRINGS = `${OUT_DIR}/serve-app-no-big-strings.js`;
const HELLO = `${OUT_DIR}/hello.js`;
const RUNS = 7;

const log = console.log.bind(console);

const buildVariants = async (): Promise<void> => {
  await Deno.mkdir(OUT_DIR, { recursive: true });

  // The real production pipeline (same plugins, minify, asset inlining) —
  // only the entry point differs, so importing it starts no server.
  await buildEdgeBundle({
    emit: async ({ content }) => {
      await Deno.writeTextFile(FULL, content);
    },
    entryPoint: "./src/serve-app.ts",
    label: "Bench",
    // esbuild names the output after the entry basename under ./dist.
    outfile: "serve-app.js",
  });

  // Same contents, but nothing evaluates until the first request — its
  // import time is the parse/compile share of the full variant's.
  await buildEdgeBundle({
    emit: async ({ content }) => {
      await Deno.writeTextFile(LAZY, content);
    },
    entryPoint: "./scripts/bench/cold-start/lazy-entry.ts",
    label: "Bench",
    outfile: "lazy-entry.js",
    skipClientBuild: true,
  });

  const full = await Deno.readTextFile(FULL);

  const noWasm = stripBase64Payloads(full, 50_000);
  await Deno.writeTextFile(NO_WASM, noWasm.code);

  const noBigStrings = stripLongStrings(noWasm.code, 20_000);
  await Deno.writeTextFile(NO_BIG_STRINGS, noBigStrings.code);

  await Deno.writeTextFile(
    HELLO,
    'export const serveHandler = () => new Response("ok");\n',
  );

  log(
    `Variants built: full ${(full.length / 1e6).toFixed(2)}MB, ` +
      `no-wasm strips ${(strippedChars(noWasm) / 1e6).toFixed(2)}MB, ` +
      `no-big-strings strips a further ${(
        strippedChars(noBigStrings) / 1e6
      ).toFixed(2)}MB`,
  );
};

type ChildTimings = {
  firstRequestMs: number | null;
  importMs: number;
  runtimeBootMs: number;
};

const measureOnce = async (
  bundle: string,
  mode: "import" | "request",
): Promise<ChildTimings> => {
  const args = [
    "run",
    "--quiet",
    "--no-check",
    "--no-code-cache",
    "--allow-read",
    "--allow-env",
    "scripts/bench/cold-start/measure-import.ts",
    bundle,
  ];
  if (mode === "request") args.push("request");
  const command = new Deno.Command(Deno.execPath(), {
    args,
    clearEnv: true,
    env: benchChildEnv({
      // A valid 32-byte key so the boot checks in "request" mode pass.
      DB_ENCRYPTION_KEY: encodeBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      ),
    }),
    stderr: "inherit",
    stdout: "piped",
  });
  const { code, stdout } = await command.output();
  if (code !== 0) throw new Error(`measure-import failed for ${bundle}`);
  return JSON.parse(new TextDecoder().decode(stdout)) as ChildTimings;
};

type VariantReport = {
  bundle: string;
  firstRequestMs: number | null;
  importMs: number;
  name: string;
  runtimeBootMs: number;
  sizeBytes: number;
};

const measureVariant = async (
  name: string,
  bundle: string,
  mode: "import" | "request",
): Promise<VariantReport> => {
  const runs: ChildTimings[] = [];
  for (let i = 0; i < RUNS; i++) runs.push(await measureOnce(bundle, mode));
  const firstRequestRuns = runs
    .map((r) => r.firstRequestMs)
    .filter((v): v is number => v !== null);
  return {
    bundle,
    firstRequestMs: firstRequestRuns.length ? median(firstRequestRuns) : null,
    importMs: median(runs.map((r) => r.importMs)),
    name,
    runtimeBootMs: median(runs.map((r) => r.runtimeBootMs)),
    sizeBytes: (await Deno.stat(bundle)).size,
  };
};

const printReport = (reports: VariantReport[]): void => {
  const pad = (value: string, width: number): string => value.padStart(width);
  log(`\nMedians of ${RUNS} fresh-process runs (--no-code-cache):\n`);
  log(
    `${"variant".padEnd(16)}${pad("size", 10)}${pad("import", 12)}${pad(
      "first request",
      16,
    )}`,
  );
  for (const r of reports) {
    log(
      `${r.name.padEnd(16)}${pad(`${(r.sizeBytes / 1e6).toFixed(2)}MB`, 10)}${pad(
        `${r.importMs.toFixed(1)}ms`,
        12,
      )}${pad(
        r.firstRequestMs === null ? "—" : `${r.firstRequestMs.toFixed(1)}ms`,
        16,
      )}`,
    );
  }
  const hello = reports.find((r) => r.name === "hello");
  const full = reports.find((r) => r.name === "full");
  const lazy = reports.find((r) => r.name === "lazy-entry");
  const noWasm = reports.find((r) => r.name === "no-wasm");
  const noBig = reports.find((r) => r.name === "no-big-strings");
  if (!(hello && full && lazy && noWasm && noBig)) return;
  log("\nAttribution (import medians):");
  log(
    `  bundle load over baseline:        ${(full.importMs - hello.importMs).toFixed(1)}ms`,
  );
  log(
    `  ...of which eager top-level eval: ${(full.importMs - lazy.importMs).toFixed(1)}ms (lazy-entry defers it to first request)`,
  );
  log(
    `  ...of which WASM base64 parse:    ${(full.importMs - noWasm.importMs).toFixed(1)}ms`,
  );
  log(
    `  ...of which other big strings:    ${(noWasm.importMs - noBig.importMs).toFixed(1)}ms`,
  );
};

const main = async (): Promise<void> => {
  if (!Deno.args.includes("--skip-build")) await buildVariants();

  const reports: VariantReport[] = [
    await measureVariant("hello", HELLO, "request"),
    await measureVariant("full", FULL, "request"),
    await measureVariant("lazy-entry", LAZY, "request"),
    await measureVariant("no-wasm", NO_WASM, "import"),
    await measureVariant("no-big-strings", NO_BIG_STRINGS, "import"),
  ];
  printReport(reports);
};

await main();
