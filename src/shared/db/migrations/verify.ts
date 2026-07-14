import { assertLiveTableColumns } from "./schema-assertions.ts";
import {
  getAppSchemaColumns,
  type LiveSchema,
  snapshotLiveSchema,
} from "./schema-sync.ts";
import type {
  AdditiveMigration,
  Migration,
  SchemaRequirement,
} from "./types.ts";

const assertRequiredTables = (
  live: LiveSchema,
  req: SchemaRequirement,
): void => {
  for (const name of req.newTables ?? []) {
    assertLiveTableColumns("migration", live, name, [
      ...getAppSchemaColumns(name),
    ]);
  }
  for (const [name, cols] of Object.entries(req.columns ?? {})) {
    assertLiveTableColumns("migration", live, name, cols);
  }
};

/** Build a check that every named object in a live set matches `expected`:
 *  "present" throws "missing <noun> <name>" for the first one absent;
 *  "absent" throws "legacy <noun> <name> still present" for the first
 *  survivor a migration was supposed to have dropped. */
const assertMembership =
  (
    liveSet: (live: LiveSchema) => { has(name: string): boolean },
    noun: string,
    expected: "present" | "absent",
  ) =>
  (live: LiveSchema, names: readonly string[] | undefined): void => {
    const violates = (name: string): boolean => {
      const isPresent = liveSet(live).has(name);
      return expected === "present" ? !isPresent : isPresent;
    };
    const failing = (names ?? []).find(violates);
    if (failing === undefined) return;
    throw new Error(
      expected === "present"
        ? `Migration verification failed: missing ${noun} ${failing}`
        : `Migration verification failed: legacy ${noun} ${failing} still present`,
    );
  };

const assertRequiredIndexes = assertMembership(
  (live) => live.indexes,
  "index",
  "present",
);
const assertRequiredTriggers = assertMembership(
  (live) => live.triggers,
  "trigger",
  "present",
);
const assertAbsentTables = assertMembership(
  (live) => live.tables,
  "table",
  "absent",
);

/**
 * Build a verify() that checks only the objects a migration owns, from a single
 * schema snapshot.
 */
export const verifyRequirement =
  (req: SchemaRequirement) => async (): Promise<void> => {
    const live = await snapshotLiveSchema();
    assertRequiredTables(live, req);
    assertRequiredIndexes(live, req.indexes);
    assertRequiredTriggers(live, req.triggers);
    assertAbsentTables(live, req.absentTables);
  };

/** Build a migration whose verify() is derived from the objects it owns. */
export const additive = (m: AdditiveMigration): Migration => ({
  ...m,
  verify: verifyRequirement(m.requires),
});
