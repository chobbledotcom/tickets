import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  combinedFailures,
  isMissingMigrationsTableError,
  isMissingSettingsTableError,
  MigrationInProgressError,
  MissingSettingsTableError,
} from "#shared/db/migrations/errors.ts";

describe("migration errors", () => {
  test("names a missing settings table with its default message", () => {
    const error = new MissingSettingsTableError();

    expect(error.name).toBe("MissingSettingsTableError");
    expect(error.message).toBe("Database settings table does not exist");
  });

  test("keeps a specific missing settings message", () => {
    expect(new MissingSettingsTableError("Settings are empty").message).toBe(
      "Settings are empty",
    );
  });

  test("names a migration already in progress", () => {
    expect(new MigrationInProgressError().name).toBe(
      "MigrationInProgressError",
    );
  });

  test("spots a missing settings table however the database spells it", () => {
    expect(
      isMissingSettingsTableError(new Error("no such table: settings")),
    ).toBe(true);
    // Some databases answer in capitals, or name the schema the table is in.
    expect(
      isMissingSettingsTableError(
        new Error("SQLITE_ERROR: No Such Table: settings"),
      ),
    ).toBe(true);
    expect(
      isMissingSettingsTableError(new Error("no such table: main.settings")),
    ).toBe(true);
  });

  test("does not mistake another missing table for the settings table", () => {
    expect(
      isMissingSettingsTableError(new Error("no such table: listings")),
    ).toBe(false);
    expect(
      isMissingSettingsTableError(
        new Error("no such table: schema_migrations"),
      ),
    ).toBe(false);
  });

  test("spots a missing migration history table", () => {
    expect(
      isMissingMigrationsTableError(
        new Error("no such table: schema_migrations"),
      ),
    ).toBe(true);
    expect(
      isMissingMigrationsTableError(new Error("no such table: settings")),
    ).toBe(false);
  });

  test("reports both failures together", () => {
    const first = new Error("first");
    const second = new Error("second");

    const combined = combinedFailures("both went wrong", first, second);

    expect(combined.message).toBe("both went wrong");
    expect(combined.errors).toEqual([first, second]);
  });
});
