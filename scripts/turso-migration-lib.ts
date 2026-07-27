import {
  checkedSource,
  configuredOrAsked,
  migrateDatabase,
  reportCleanupError,
  requiredAnswer,
  runMigrationTask,
  type TursoMigrationDeps,
} from "#scripts/turso-migration-steps.ts";
import { slugifyForTurso } from "#shared/turso-api.ts";

export const MIGRATE_TURSO_USAGE = "Usage: deno task migrate:turso";

export type MigrateTursoCliDeps = TursoMigrationDeps;

/** Run the interactive source-to-Turso database migration. */
export const runMigrateTursoCli = (
  deps: MigrateTursoCliDeps,
): Promise<number> =>
  runMigrationTask(deps, MIGRATE_TURSO_USAGE, async () => {
    const dbUrl = requiredAnswer(
      deps.prompt("Source database URL:"),
      "Source database URL",
    );
    const dbToken = requiredAnswer(
      deps.promptSecret("Source database password or token (DB_TOKEN):"),
      "Source database password or token",
    );
    const requestedName = requiredAnswer(
      deps.prompt("Destination Turso database name:"),
      "Destination Turso database name",
    );
    const name = slugifyForTurso(requestedName);
    const apiToken = configuredOrAsked(
      deps,
      "TURSO_API_TOKEN",
      "Destination Turso API key:",
    );
    const source = checkedSource({ dbToken, dbUrl });
    const api = deps.createApi(apiToken, deps.signal);
    const outcome = await migrateDatabase(deps, api, source, name);
    deps.stdout(
      "Keep using the source DB_ENCRYPTION_KEY. It is not stored in the database file.",
    );
    return reportCleanupError(deps, outcome) ? 1 : 0;
  });
