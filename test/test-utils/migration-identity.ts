/** The identity a dated migration declares, asserted in one place so each
 *  migration test states its own expectations as data. */

import { expect } from "@std/expect";
import type { Migration } from "#db/migrations/types.ts";

/** What a migration declares about itself: the id the database records, the
 *  description the guide shows, and the schema objects it owns. */
export type DeclaredMigrationIdentity = Pick<
  Migration,
  "description" | "id" | "requires"
>;

/** Assert that a migration declares exactly this identity. */
export const expectMigrationIdentity = (
  migration: Migration,
  expected: DeclaredMigrationIdentity,
): void => {
  expect({
    description: migration.description,
    id: migration.id,
    requires: migration.requires,
  }).toEqual(expected);
};
