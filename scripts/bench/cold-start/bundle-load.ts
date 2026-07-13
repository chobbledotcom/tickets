/**
 * Cold-start benchmark 1: the CPU cost of loading the production bundle
 * (parse + compile + top-level eval), timed as fresh `--no-code-cache`
 * `deno run` imports of the real bundle plus variants: `hello` (process
 * floor), `full`, `no-wasm` (base64 blobs emptied), `no-big-strings`
 * (inlined client assets emptied too). "Request" mode also serves
 * /robots.txt once to time lazy evaluation + boot checks.
 *
 * Run with: deno run -A scripts/bench/cold-start/bundle-load.ts [--skip-build]
 */

import { encodeBase64 } from "jsr:@std/encoding@^1.0.0/base64";
import { buildEdgeBundle } from "../../edge-bundle-lib.ts";
import { spawnChildJson } from "./spawn-child.ts";
import { median, stripBase64Payloads, strippedChars } from "./strip-lib.ts";

const OUT_DIR = "./dist/bench-cold-start";
const FULL = `${OUT_DIR}/serve-app.js`;
const LAZY = `${OUT_DIR}/lazy-entry.js`;
const NO_WASM = `${OUT_DIR}/serve-app-no-wasm.js`;
const NO_BIG_STRINGS = `${OUT_DIR}/serve-app-no-big-strings.js`;
const HELLO = `${OUT_DIR}/hello.js`;
const RUNS = 7;

const log = console.log.bind(console);

/** A `buildEdgeBundle` emit callback that writes the bundle straight to `path`. */
const emitTo =
  (path: string) =>
  async ({ content }: { content: string }): Promise<void> => {
    await Deno.writeTextFile(path, content);
  };

const buildVariants = async (): Promise<void> => {
  await Deno.mkdir(OUT_DIR, { recursive: true });

  // Real production pipeline; only the entry differs, so no server starts.
  await buildEdgeBundle({
    emit: emitTo(FULL),
    entryPoint: "./src/serve-app.ts",
    label: "Bench",
    // esbuild names the output after the entry basename under ./dist.
    outfile: "serve-app.js",
  });

  // Same contents behind await import(): isolates the parse/compile share.
  await buildEdgeBundle({
    emit: emitTo(LAZY),
    entryPoint: "./scripts/bench/cold-start/lazy-entry.ts",
    label: "Bench",
    outfile: "lazy-entry.js",
    skipClientBuild: true,
  });

  // Inlined client assets emptied at build time (exact, unlike text surgery
  // on minified JS); with the WASM strip this isolates the big strings' cost.
  await buildEdgeBundle({
    emit: async ({ content }) => {
      await Deno.writeTextFile(
        NO_BIG_STRINGS,
        stripBase64Payloads(content, 50_000).code,
      );
    },
    emptyInlinedAssets: true,
    entryPoint: "./src/serve-app.ts",
    label: "Bench",
    outfile: "serve-app.js",
    skipClientBuild: true,
  });

  const full = await Deno.readTextFile(FULL);

  const noWasm = stripBase64Payloads(full, 50_000);
  await Deno.writeTextFile(NO_WASM, noWasm.code);

  await Deno.writeTextFile(
    HELLO,
    'export const serveHandler = () => new Response("ok");\n',
  );

  log(
    `Variants built: full ${(full.length / 1e6).toFixed(2)}MB, ` +
      `no-wasm strips ${(strippedChars(noWasm) / 1e6).toFixed(2)}MB of base64, ` +
      `no-big-strings also drops the inlined assets (${(
        (await Deno.stat(NO_BIG_STRINGS)).size / 1e6
      ).toFixed(2)}MB)`,
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
  // Generous timeout so a never-resolving bundle fails instead of blocking.
  return spawnChildJson<ChildTimings>(
    args,
    {
      // Valid 32-byte key so "request" mode passes boot checks.
      DB_ENCRYPTION_KEY: encodeBase64(
        crypto.getRandomValues(new Uint8Array(32)),
      ),
    },
    60_000,
    `measure-import of ${bundle} (${mode} mode)`,
  );
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
