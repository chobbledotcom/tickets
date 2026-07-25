import { namedError } from "#shared/named-error.ts";

export class MissingSettingsTableError extends namedError(
  "MissingSettingsTableError",
) {
  constructor(message = "Database settings table does not exist") {
    super(message);
  }
}

/** Another isolate is updating the database, so this request can be retried. */
export class MigrationInProgressError extends namedError(
  "MigrationInProgressError",
) {}
