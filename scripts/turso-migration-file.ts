import {
  checkLocalSnapshot,
  type SnapshotClientFactory,
  type SnapshotQueryCheck,
  type SnapshotQueryResult,
} from "#scripts/database-snapshot-lib.ts";
import { parseApiError } from "#shared/fetch.ts";
import type { DatabaseCredentials } from "#shared/provider-types.ts";
import { requireSuccess } from "#shared/result.ts";

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
  signal?: AbortSignal,
): Promise<void> =>
  checkLocalSnapshot(path, factory, TURSO_FILE_REQUIREMENTS, signal);

const databaseUploadUrl = (dbUrl: string): URL => {
  const source = new URL(dbUrl);
  if (source.protocol !== "libsql:" && source.protocol !== "https:") {
    throw new Error("Turso database URL must use TLS");
  }
  return new URL(`https://${source.host}/v1/upload`);
};

const UPLOAD_DEADLINE_MS = 10 * 60_000;

/** The error an interrupted or overdue upload rejects with. */
const abortReason = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  return new Error(
    `Upload aborted: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
};

/** Fetch derives Content-Length from the body, not the supplied header. */
class UploadFileBody extends Blob {
  constructor(
    private readonly file: Deno.FsFile,
    private readonly byteLength: number,
  ) {
    super();
  }

  override get size(): number {
    return this.byteLength;
  }

  override stream() {
    // A fresh stream lets fetch attach the Blob size to its upload resource.
    return ReadableStream.from(this.file.readable);
  }
}

/** Stream a SQLite file into a Turso database without holding it in memory. */
export const uploadTursoDatabaseFile = async (
  path: string,
  credentials: DatabaseCredentials,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  const info = await Deno.stat(path);
  if (!info.isFile) throw new Error(`Database snapshot is not a file: ${path}`);
  const controller = new AbortController();
  const uploadSignal =
    signal === undefined
      ? controller.signal
      : AbortSignal.any([signal, controller.signal]);
  const timer = setTimeout(
    () => controller.abort(new Error("Upload exceeded the 10-minute deadline")),
    UPLOAD_DEADLINE_MS,
  );
  try {
    uploadSignal.throwIfAborted();
    using file = await Deno.open(path, { read: true });
    const response = await fetcher(databaseUploadUrl(credentials.dbUrl), {
      body: new UploadFileBody(file, info.size),
      headers: {
        Authorization: `Bearer ${credentials.dbToken}`,
        Connection: "close",
      },
      method: "POST",
      redirect: "error",
      signal: uploadSignal,
    });
    const text = await response.text();
    if (!response.ok) {
      requireSuccess(
        parseApiError({ status: response.status, text }, "Upload database"),
      );
    }
  } catch (error) {
    if (uploadSignal.aborted) throw abortReason(uploadSignal);
    throw error;
  } finally {
    clearTimeout(timer);
  }
};
