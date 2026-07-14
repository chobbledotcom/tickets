/** Shared state helpers for fresh-process cold-start benchmarks. */

export const requiredEnv = (key: string): string => {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
};

export const sampleMap = <Key, Sample>(
  keys: readonly Key[],
): Map<Key, Sample[]> => new Map(keys.map((key) => [key, []]));

export const samplesFor = <Key, Sample>(
  samples: ReadonlyMap<Key, Sample[]>,
  key: Key,
): Sample[] => {
  const found = samples.get(key);
  if (!found) throw new Error(`Samples missing for ${String(key)}`);
  return found;
};
