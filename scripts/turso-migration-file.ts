import {
  checkLocalSnapshot,
  type SnapshotClientFactory,
  type SnapshotQueryCheck,
  type SnapshotQueryResult,
} from "#scripts/database-snapshot-lib.ts";
import type { DatabaseCredentials } from "#shared/provider-types.ts";
import { requireSuccess } from "#shared/result.ts";
import type { TursoApi } from "#shared/turso-api.ts";

const tursoFileRequirement = (
  sql: string,
  key: string,
  expected: string | number,
  message: string,
): SnapshotQueryCheck => ({
  sql,
  verify: (result: SnapshotQueryResult) => {
    if (result.rows.length !== 1 || result.rows[0]?.[key] !== expected) {
      throw new Error(message);
    }
  },
});

const TURSO_FILE_REQUIREMENTS = [
  tursoFileRequirement(
    "PRAGMA journal_mode",
    "journal_mode",
    "wal",
    "Database file must use WAL journal mode",
  ),
  tursoFileRequirement(
    "PRAGMA page_size",
    "page_size",
    4096,
    "Database file must use 4096-byte pages",
  ),
  tursoFileRequirement(
    "PRAGMA auto_vacuum",
    "auto_vacuum",
    0,
    "Database file must have auto-vacuum disabled",
  ),
  tursoFileRequirement(
    "PRAGMA encoding",
    "encoding",
    "UTF-8",
    "Database file must use UTF-8 encoding",
  ),
];

/** Check every SQLite setting required by Turso's binary upload endpoint. */
export const verifyTursoUploadFile = (
  path: string,
  factory: SnapshotClientFactory,
): Promise<void> => checkLocalSnapshot(path, factory, TURSO_FILE_REQUIREMENTS);

const readableFile = (file: Deno.FsFile): ReadableStream<Uint8Array> => {
  const buffer = new Uint8Array(64 * 1024);
  return new ReadableStream({
    async pull(controller) {
      const bytesRead = await file.read(buffer);
      if (bytesRead === null) {
        controller.close();
        return;
      }
      controller.enqueue(buffer.slice(0, bytesRead));
    },
  });
};

/** Stream a SQLite file into a Turso database without holding it in memory. */
export const uploadTursoDatabaseFile = async (
  path: string,
  api: TursoApi,
  credentials: DatabaseCredentials,
): Promise<void> => {
  const info = await Deno.stat(path);
  if (!info.isFile) throw new Error(`Database snapshot is not a file: ${path}`);
  const file = await Deno.open(path, { read: true });
  try {
    requireSuccess(
      await api.uploadDatabase(credentials, readableFile(file), info.size),
    );
  } finally {
    file.close();
  }
};
