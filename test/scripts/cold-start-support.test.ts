import { expect } from "@std/expect";
import { describe, test } from "@std/testing/bdd";
import {
  balancedRotation,
  benchmarkCatalogueMarkers,
  requireBenchmarkCatalogue,
  requiredEnv,
  sampleMap,
  samplesFor,
} from "../../scripts/bench/cold-start/support.ts";

const completeCatalogueBody = (): string =>
  benchmarkCatalogueMarkers().join("\n");

describe("cold-start benchmark support", () => {
  test("balancedRotation balances positions and pair order", () => {
    const items = ["a", "b", "c"];
    expect(
      Array.from({ length: 6 }, (_, run) => balancedRotation(items, run)),
    ).toEqual([
      ["a", "b", "c"],
      ["b", "c", "a"],
      ["c", "a", "b"],
      ["c", "b", "a"],
      ["b", "a", "c"],
      ["a", "c", "b"],
    ]);
  });

  test("requireBenchmarkCatalogue accepts the complete seeded page", () => {
    expect(() =>
      requireBenchmarkCatalogue(
        { body: completeCatalogueBody(), status: 200 },
        "request",
      ),
    ).not.toThrow();
  });

  test("requireBenchmarkCatalogue rejects an error response", () => {
    expect(() =>
      requireBenchmarkCatalogue({ body: "", status: 500 }, "request"),
    ).toThrow("request failed with status 500");
  });

  test("requireBenchmarkCatalogue rejects a partial catalogue", () => {
    expect(() =>
      requireBenchmarkCatalogue(
        {
          body: completeCatalogueBody().replace("Benchmark listing 14", ""),
          status: 200,
        },
        "request",
      ),
    ).toThrow("request did not render Benchmark listing 14");
  });

  test("requiredEnv returns a configured value", () => {
    const key = "COLD_START_SUPPORT_TEST";
    Deno.env.set(key, "configured");
    try {
      expect(requiredEnv(key)).toBe("configured");
    } finally {
      Deno.env.delete(key);
    }
  });

  test("requiredEnv rejects a missing value", () => {
    const key = "COLD_START_SUPPORT_MISSING_TEST";
    Deno.env.delete(key);
    expect(() => requiredEnv(key)).toThrow(`${key} is required`);
  });

  test("sampleMap stores samples for each requested key", () => {
    const samples = sampleMap<string, number>(["cold", "warm"]);
    samplesFor(samples, "cold").push(42);
    expect(samplesFor(samples, "cold")).toEqual([42]);
    expect(samplesFor(samples, "warm")).toEqual([]);
  });

  test("samplesFor rejects an unknown key", () => {
    expect(() => samplesFor(sampleMap(["cold"]), "warm")).toThrow(
      "Samples missing for warm",
    );
  });
});
