import type { SiteMigrationDeps } from "#scripts/site-migration/run.ts";
import type { SiteWithHost } from "#scripts/site-migration/sites.ts";
import { databaseHostFor } from "#shared/db/host.ts";
import {
  type TursoMigrationCliOptions,
  type TursoMigrationCliState,
  tursoMigrationCliState,
} from "#test-utils/turso-migration.ts";

export interface SiteMigrationCliOptions extends TursoMigrationCliOptions {
  siteDeps?: Partial<SiteMigrationDeps>;
  sites?: SiteWithHost[];
}

export interface SiteMigrationCliState
  extends Omit<TursoMigrationCliState, "deps"> {
  deps: SiteMigrationDeps;
  secretUpdates: {
    bunnyApiKey: string;
    scriptId: number;
    secrets: string[][];
  }[];
  sites: SiteWithHost[];
}

/** A site on a Bunny database, as the main site would report it. */
export const bunnySite = (name: string, scriptId: number): SiteWithHost => ({
  dbToken: `${name}-token`,
  dbUrl: `libsql://abc-${name}.lite.bunnydb.net`,
  host: databaseHostFor(`libsql://abc-${name}.lite.bunnydb.net`),
  name,
  scriptId,
});

export const siteMigrationCliState = (
  options: SiteMigrationCliOptions = {},
): SiteMigrationCliState => {
  const sites = options.sites ?? [bunnySite("first-site", 42)];
  const secretUpdates: SiteMigrationCliState["secretUpdates"] = [];
  const base = tursoMigrationCliState({
    ...options,
    env: {
      BUNNY_API_KEY: "bunny-key",
      MAIN_INSTANCE_KEY: "main-key",
      MAIN_INSTANCE_URL: "https://main.example.com",
      ...options.env,
    },
    promptAnswers: options.promptAnswers ?? ["1", sites[0]?.name ?? "", "q"],
    secretAnswers: options.secretAnswers ?? [],
  });
  const deps: SiteMigrationDeps = {
    ...base.deps,
    fetchSites: () => Promise.resolve(sites),
    setSiteSecrets: (bunnyApiKey, scriptId, secrets) => {
      secretUpdates.push({ bunnyApiKey, scriptId, secrets });
      return Promise.resolve();
    },
    ...options.siteDeps,
  };
  return { ...base, deps, secretUpdates, sites };
};
