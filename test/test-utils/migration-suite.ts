import { it as test } from "@std/testing/bdd";
import { applySchemaChanges } from "#db/migrations/schema-sync.ts";
import type { Migration, MigrationContext } from "#db/migrations/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  type DeclaredMigrationIdentity,
  expectMigrationIdentity,
} from "#test-utils/migration-identity.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

/** The names a migration suite goes by: its title under `db > migrations >`
 *  and the name of the test that asserts its declared identity. */
export type MigrationSuiteNames = {
  title: string;
  identityTest: string;
};

/**
 * Run one dated migration's database suite. The identity test comes first, and
 * `body` adds the behaviour tests beside one `run` that applies the migration
 * to the live test database.
 */
export const describeMigrationSuite = (
  names: MigrationSuiteNames,
  migrationOf: (context: MigrationContext) => Migration,
  identity: DeclaredMigrationIdentity,
  body: (run: () => Promise<void>) => void,
): void => {
  const context = buildMigrationContext({ applySchemaChanges });
  describeWithEnv(`db > migrations > ${names.title}`, { db: true }, () => {
    test(names.identityTest, () => {
      expectMigrationIdentity(migrationOf(context), identity);
    });
    body(() => migrationOf(context).up());
  });
};
