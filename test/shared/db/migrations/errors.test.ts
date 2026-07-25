import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
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
});
