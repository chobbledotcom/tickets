import { okResult } from "#shared/result.ts";
import type {
  CreateTursoDatabaseRequest,
  TursoApi,
  TursoDatabaseCredentials,
} from "#shared/turso-api.ts";

export const TEST_TURSO_CREDENTIALS: TursoDatabaseCredentials = {
  dbId: "database-id",
  dbToken: "database-token",
  dbUrl: "libsql://destination.turso.io",
  name: "destination-database",
};

/** A successful Turso API fake whose individual operations can be replaced. */
export const fakeTursoApi = (overrides: Partial<TursoApi> = {}): TursoApi => ({
  createDatabase: (_request: CreateTursoDatabaseRequest) =>
    Promise.resolve(okResult(TEST_TURSO_CREDENTIALS)),
  databaseExists: (_organization: string, _name: string) =>
    Promise.resolve(okResult(false)),
  deleteDatabase: (_organization: string, _name: string) =>
    Promise.resolve(okResult(undefined)),
  listGroups: (_organization: string) => Promise.resolve(okResult(["default"])),
  listOrganizations: () => Promise.resolve(okResult(["personal"])),
  ...overrides,
});
