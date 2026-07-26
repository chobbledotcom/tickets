import { numberedLines, readMenuChoice } from "#scripts/site-migration/menu.ts";
import type {
  MainInstance,
  SiteWithHost,
} from "#scripts/site-migration/sites.ts";
import {
  configuredOrAsked,
  configuredValue,
  MigrationCancelled,
  migrateDatabase,
  reportCleanupError,
  reportMigrationFailure,
  requiredAnswer,
  runMigrationTask,
  type TursoMigrationDeps,
} from "#scripts/turso-migration-steps.ts";
import { slugifyForTurso, type TursoApi } from "#shared/turso-api.ts";

export const MIGRATE_SITES_USAGE = "Usage: deno task migrate:sites";

/** Names of the two secrets that point a site at its database. */
export const DATABASE_SECRET_NAMES = { token: "DB_TOKEN", url: "DB_URL" };

export interface SiteMigrationDeps extends TursoMigrationDeps {
  fetchSites: (instance: MainInstance) => Promise<SiteWithHost[]>;
  setSiteSecrets: (
    bunnyApiKey: string,
    scriptId: number,
    secrets: [string, string][],
  ) => Promise<void>;
}

/** How each site reads in the menu. */
const siteLabel = (site: SiteWithHost): string =>
  `${site.name} — ${site.host} database (script ${site.scriptId})`;

/** Ask where the list of sites should be read from. */
const readMainInstance = (deps: SiteMigrationDeps): MainInstance => ({
  key: configuredOrAsked(deps, "MAIN_INSTANCE_KEY", "Main site key:"),
  url:
    configuredValue(deps, "MAIN_INSTANCE_URL") ??
    requiredAnswer(
      deps.prompt("Main site address (https://...):"),
      "Main site address",
    ),
});

/** Show the sites and let the person pick one, or stop. */
const chooseSite = (
  deps: SiteMigrationDeps,
  sites: SiteWithHost[],
): SiteWithHost | "quit" => {
  deps.stdout("\nSites:");
  for (const line of numberedLines(sites.map(siteLabel))) deps.stdout(line);
  const choice = readMenuChoice(
    deps.prompt("Choose a site to migrate (q to quit):"),
    sites,
  );
  return choice === "quit" ? "quit" : choice.chosen;
};

/** Refuse anything that is not still on a Bunny database. */
const requireBunnySite = (site: SiteWithHost): void => {
  if (site.host !== "bunny") {
    throw new Error(
      `${site.name} is not on a Bunny database (it is on: ${site.host}).`,
    );
  }
};

/** Make the person type the site name before anything is changed. */
const confirmSite = (deps: SiteMigrationDeps, site: SiteWithHost): void => {
  const typed = requiredAnswer(
    deps.prompt(`Type the site name to confirm (${site.name}):`),
    "Site name",
  );
  if (typed !== site.name) {
    throw new Error(
      "Site name does not match. Please type the exact name to confirm.",
    );
  }
};

/** Copy one site's database to Turso and point the site at the new database. */
const migrateSite = async (
  deps: SiteMigrationDeps,
  api: TursoApi,
  site: SiteWithHost,
  bunnyApiKey: string,
): Promise<number> => {
  requireBunnySite(site);
  confirmSite(deps, site);
  const outcome = await migrateDatabase(
    deps,
    api,
    { dbToken: site.dbToken, dbUrl: site.dbUrl },
    slugifyForTurso(site.name),
  );
  deps.stdout("Pointing the site at the new database...");
  await deps.setSiteSecrets(bunnyApiKey, site.scriptId, [
    [DATABASE_SECRET_NAMES.url, outcome.credentials.dbUrl],
    [DATABASE_SECRET_NAMES.token, outcome.credentials.dbToken],
  ]);
  deps.stdout(`${site.name} now uses its Turso database.`);
  return reportCleanupError(deps, outcome) ? 1 : 0;
};

/** One round of the menu: list the sites, pick one, and migrate it. */
const migrateOneRound = async (
  deps: SiteMigrationDeps,
  api: TursoApi,
  instance: MainInstance,
  bunnyApiKey: string,
): Promise<number | "quit"> => {
  deps.stdout("Reading the site list from the main site...");
  const sites = await deps.fetchSites(instance);
  if (sites.length === 0) throw new Error("The main site listed no sites.");
  try {
    const site = chooseSite(deps, sites);
    if (site === "quit") return "quit";
    return await migrateSite(deps, api, site, bunnyApiKey);
  } catch (error) {
    // One site failing should not end the session — report it and ask again.
    if (deps.signal.aborted || error instanceof MigrationCancelled) throw error;
    return reportMigrationFailure(deps, error);
  }
};

/** Run the site migration menu until the person quits. */
export const runSiteMigrationTui = (deps: SiteMigrationDeps): Promise<number> =>
  runMigrationTask(deps, MIGRATE_SITES_USAGE, async () => {
    const instance = readMainInstance(deps);
    const bunnyApiKey = configuredOrAsked(deps, "BUNNY_API_KEY", "Bunny key:");
    const api = deps.createApi(
      configuredOrAsked(deps, "TURSO_API_TOKEN", "Turso API key:"),
      deps.signal,
    );
    let exitCode = 0;
    for (let running = true; running; ) {
      const round = await migrateOneRound(deps, api, instance, bunnyApiKey);
      if (round === "quit") running = false;
      else exitCode = round;
    }
    return exitCode;
  });
