/**
 * Global cache stats registry.
 * Cache modules register stat providers at load time;
 * the debug footer reads them at render time.
 */

/** A single cache's stats snapshot */
export type CacheStat = {
  readonly name: string;
  readonly entries: number;
  readonly capacity?: number;
};

type CacheStatProvider = () => CacheStat;

const providers: CacheStatProvider[] = [];

/** Register a cache stat provider (called at module load time) */
export const registerCache = (provider: CacheStatProvider): void => {
  providers.push(provider);
};

/** Collect stats from all registered caches */
export const getAllCacheStats = (): CacheStat[] => providers.map((p) => p());

/** Reset the registry (for testing) */
export const resetCacheRegistry = (): void => {
  providers.length = 0;
};
