import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseImportSpecifiers } from "#scripts/unit-tests-report-imports.ts";

const SCRIPT_URL = new URL(
  "../../scripts/bench/bunny-crypto-smoke.ts",
  import.meta.url,
);
const SCRIPT_SOURCE = await Deno.readTextFile(SCRIPT_URL);

type SmokeScript = {
  run: () => Promise<Record<string, unknown>>;
};

const loadSmokeScript = async (): Promise<SmokeScript> => {
  const { stop, transform } = await import("esbuild");
  const testSource = SCRIPT_SOURCE.replace(
    'import * as BunnySDK from "@bunny.net/edgescript-sdk";',
    "const BunnySDK = { net: { http: { serve: (_handler: unknown) => {} } } };",
  )
    .replace("const ITERS = 2000;", "const ITERS = 2;")
    .concat("\nexport { run };\n");
  try {
    const { code } = await transform(testSource, {
      format: "esm",
      loader: "ts",
    });
    return import(
      `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}#${crypto.randomUUID()}`
    );
  } finally {
    stop();
  }
};

describe("Bunny crypto smoke script", () => {
  test("has no project imports when uploaded directly", () => {
    expect(parseImportSpecifiers(SCRIPT_SOURCE)).toEqual([
      "@bunny.net/edgescript-sdk",
      "node:crypto",
    ]);
  });

  test("keeps Node and Web Crypto encryption interoperable", async () => {
    const result = await (await loadSmokeScript()).run();

    expect(result.nodeCryptoLoaded).toBe(true);
    expect(result.createCipheriv).toBe("function");
    expect(result.nodeRoundTrip).toBe(true);
    expect(result.nodeDecryptsSubtle).toBe(true);
    expect(result.subtleDecryptsNode).toBe(true);
    expect(result.iterations).toBe(2);
    expect(result.verdict).toMatch(/^node:crypto works and is interoperable/);
  });
});
