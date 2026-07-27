import { errorMessage } from "#shared/error-message.ts";
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

/** Report both failures together when cleaning up after one of them fails. */
export const combinedFailures = (
  message: string,
  first: unknown,
  second: unknown,
): AggregateError => new AggregateError([first, second], message);

/** Build a checker for "this exact table is missing" database errors. */
const missingTableError =
  (table: string) =>
  (error: unknown): boolean => {
    const message = errorMessage(error);
    return new RegExp(`no such table:?\\s*(\\w+\\.)?${table}\\b`, "i").test(
      message,
    );
  };

export const isMissingSettingsTableError = missingTableError("settings");
export const isMissingMigrationsTableError =
  missingTableError("schema_migrations");
