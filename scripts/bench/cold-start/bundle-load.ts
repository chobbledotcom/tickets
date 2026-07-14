/**
 * Cold-start benchmark 1: the CPU cost of loading the production-shaped app
 * core bundle
 * (parse + compile + top-level eval), timed as fresh `--no-code-cache`
 * `deno run` imports of the bundle plus variants: `hello` (dynamic-import
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
import { balancedRotation, sampleMap, samplesFor } from "./support.ts";

const OUT_DIR = "./dist/bench-cold-start";
const FULL = `${OUT_DIR}/serve-app.js`;
const LAZY = `${OUT_DIR}/lazy-entry.js`;
const NO_WASM = `${OUT_DIR}/serve-app-no-wasm.js`;
const NO_BIG_STRINGS = `${OUT_DIR}/serve-app-no-big-strings.js`;
const HELLO = `${OUT_DIR}/hello.js`;
const RUNS = 10;

const log = console.log.bind(console);

/** A `buildEdgeBundle` emit callback that writes the bundle straight to `path`. */
const emitTo =
  (path: string) =>
  async ({ content }: { content: string }): Promise<void> => {
    await Deno.writeTextFile(path, content);
  };

const buildVariants = async (): Promise<void> => {
  await Deno.mkdir(OUT_DIR, { recursive: true });

  // Production build pipeline with the shared app core as the entry, so no
  // platform wrapper registers a server.
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
    'export const serveHandler = () => new Response("User-agent: *\\nAllow: /listings/\\nDisallow: /\\n", { headers: { "content-type": "text/plain; charset=utf-8" } });\n',
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
  sizeBytes: number;
};

const summarizeVariant = async (
  name: string,
  bundle: string,
  runs: ChildTimings[],
): Promise<VariantReport> => {
  const firstRequestRuns = runs
    .map((r) => r.firstRequestMs)
    .filter((v): v is number => v !== null);
  return {
    bundle,
    firstRequestMs: firstRequestRuns.length ? median(firstRequestRuns) : null,
    importMs: median(runs.map((r) => r.importMs)),
    name,
    sizeBytes: (await Deno.stat(bundle)).size,
  };
};

type Variant = {
  bundle: string;
  mode: "import" | "request";
  name: string;
};

type VariantMeasurements = {
  reports: VariantReport[];
  samples: ReadonlyMap<string, ChildTimings[]>;
};

/** Balanced interleaving puts each variant in each measurement position twice. */
const measureVariants = async (
  variants: readonly Variant[],
): Promise<VariantMeasurements> => {
  // Prime filesystem pages once for every equally sized candidate. These are
  // separate fresh processes and stay outside the reported samples; Deno's
  // module code cache remains disabled in every child.
  for (const variant of variants) {
    await measureOnce(variant.bundle, variant.mode);
  }
  const samples = sampleMap<string, ChildTimings>(
    variants.map((variant) => variant.name),
  );
  for (let run = 0; run < RUNS; run++) {
    for (const variant of balancedRotation(variants, run)) {
      samplesFor(samples, variant.name).push(
        await measureOnce(variant.bundle, variant.mode),
      );
    }
  }
  return {
    reports: await Promise.all(
      variants.map((variant) =>
        summarizeVariant(
          variant.name,
          variant.bundle,
          samplesFor(samples, variant.name),
        ),
      ),
    ),
    samples,
  };
};

const pairedImportDifferences = (
  samples: ReadonlyMap<string, ChildTimings[]>,
  leftName: string,
  rightName: string,
): number[] => {
  const left = samplesFor(samples, leftName);
  const right = samplesFor(samples, rightName);
  if (left.length !== right.length) {
    throw new Error(`Run count differs for ${leftName} and ${rightName}`);
  }
  return left.map((timing, index) => {
    const paired = right[index];
    if (!paired)
      throw new Error(`Paired run ${index} missing for ${rightName}`);
    return timing.importMs - paired.importMs;
  });
};

const pairedImportMedian =
  (samples: ReadonlyMap<string, ChildTimings[]>) =>
  (leftName: string, rightName: string): number =>
    median(pairedImportDifferences(samples, leftName, rightName));

const printReport = (
  reports: VariantReport[],
  samples: ReadonlyMap<string, ChildTimings[]>,
): void => {
  const pad = (value: string, width: number): string => value.padStart(width);
  const pairedMedian = pairedImportMedian(samples);
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
  log("\nAttribution (median paired import differences):");
  log(
    `  app-core load over import floor:   ${pairedMedian("full", "hello").toFixed(1)}ms`,
  );
  log(
    `  ...of which eager top-level eval: ${pairedMedian("full", "lazy-entry").toFixed(1)}ms (lazy-entry defers it to first request)`,
  );
  log(
    `  ...of which inlined WASM literals and eager decoding: ${pairedMedian("full", "no-wasm").toFixed(1)}ms`,
  );
  log(
    `  ...of which other big strings:    ${pairedMedian("no-wasm", "no-big-strings").toFixed(1)}ms`,
  );
  log("\nRaw import samples (ms):");
  for (const report of reports) {
    log(
      `  ${report.name}: ${samplesFor(samples, report.name)
        .map((timing) => timing.importMs.toFixed(1))
        .join(", ")}`,
    );
  }
  log("\nRaw paired import differences (ms):");
  const comparisons: ReadonlyArray<readonly [string, string]> = [
    ["full", "hello"],
    ["full", "lazy-entry"],
    ["full", "no-wasm"],
    ["no-wasm", "no-big-strings"],
  ];
  for (const [left, right] of comparisons) {
    log(
      `  ${left} - ${right}: ${pairedImportDifferences(samples, left, right)
        .map((difference) => difference.toFixed(1))
        .join(", ")}`,
    );
  }
};

const main = async (): Promise<void> => {
  if (!Deno.args.includes("--skip-build")) await buildVariants();

  const { reports, samples } = await measureVariants([
    { bundle: HELLO, mode: "request", name: "hello" },
    { bundle: FULL, mode: "request", name: "full" },
    { bundle: LAZY, mode: "request", name: "lazy-entry" },
    { bundle: NO_WASM, mode: "import", name: "no-wasm" },
    { bundle: NO_BIG_STRINGS, mode: "import", name: "no-big-strings" },
  ]);
  printReport(reports, samples);
};

await main();
