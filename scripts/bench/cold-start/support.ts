/** Shared state helpers for fresh-process cold-start benchmarks. */

export const BENCHMARK_REGULAR_GROUPS = 12;
export const BENCHMARK_PACKAGE_GROUPS = 2;
export const BENCHMARK_ROBOTS_BODY =
  "User-agent: *\nAllow: /listings/\nDisallow: /\n";
export const BENCHMARK_ROBOTS_CONTENT_TYPE = "text/plain; charset=utf-8";

const numberedName = (kind: string, number: number): string =>
  `Benchmark ${kind} ${String(number).padStart(2, "0")}`;

export const benchmarkGroupName = (
  number: number,
  isPackage: boolean,
): string => numberedName(isPackage ? "package" : "group", number);

export const benchmarkListingName = (number: number): string =>
  numberedName("listing", number);

export const benchmarkCatalogueMarkers = (): string[] => [
  ...Array.from({ length: BENCHMARK_REGULAR_GROUPS }, (_, index) =>
    benchmarkGroupName(index + 1, false),
  ),
  ...Array.from({ length: BENCHMARK_PACKAGE_GROUPS }, (_, index) =>
    benchmarkGroupName(BENCHMARK_REGULAR_GROUPS + index + 1, true),
  ),
  ...Array.from(
    { length: BENCHMARK_REGULAR_GROUPS + BENCHMARK_PACKAGE_GROUPS },
    (_, index) => benchmarkListingName(index + 1),
  ),
];

/** Require every seeded group and listing, so a faster partial page cannot
 * count as a valid benchmark sample. */
export const requireBenchmarkCatalogue = (
  response: { body: string; status: number },
  what: string,
): void => {
  if (response.status !== 200) {
    throw new Error(`${what} failed with status ${response.status}`);
  }
  const missing = benchmarkCatalogueMarkers().filter(
    (marker) => !response.body.includes(marker),
  );
  if (missing.length > 0) {
    throw new Error(`${what} did not render ${missing.join(", ")}`);
  }
};

const rotate = <T>(items: readonly T[], offset: number): T[] => [
  ...items.slice(offset),
  ...items.slice(0, offset),
];

/** Rotate one full cycle forward and the next in reverse. With two cycles,
 * every item occupies every position twice and every pair's order is balanced. */
export const balancedRotation = <T>(items: readonly T[], run: number): T[] => {
  const cycle = Math.floor(run / items.length);
  const order = cycle % 2 === 0 ? items : items.toReversed();
  return rotate(order, run % items.length);
};

export const balancedCycles = <T>(
  runs: readonly T[],
  positionsPerCycle: number,
): T[][] => {
  if (runs.length % positionsPerCycle !== 0) {
    throw new Error(
      `Run count ${runs.length} must be a multiple of positions per cycle ${positionsPerCycle}`,
    );
  }
  return Array.from({ length: runs.length / positionsPerCycle }, (_, cycle) =>
    runs.slice(cycle * positionsPerCycle, (cycle + 1) * positionsPerCycle),
  );
};

export const requiredEnv = (key: string): string => {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
};

export const samplesFor = <Key, Sample>(
  samples: ReadonlyMap<Key, Sample[]>,
  key: Key,
): Sample[] => {
  const found = samples.get(key);
  if (!found) throw new Error(`Samples missing for ${String(key)}`);
  return found;
};
