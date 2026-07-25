import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import {
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { assertExists } from "@std/assert";
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
): Promise<void> => checkLocalSnapshot(path, factory, TURSO_FILE_REQUIREMENTS);

interface UploadResponse {
  ok: boolean;
  status: number;
  text: string;
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

const databaseUploadUrl = (dbUrl: string): URL => {
  const source = new URL(dbUrl);
  const loopbackHttp =
    source.protocol === "http:" && LOOPBACK_HOSTNAMES.has(source.hostname);
  if (
    source.protocol !== "libsql:" &&
    source.protocol !== "https:" &&
    !loopbackHttp
  ) {
    throw new Error("Turso database URL must use TLS");
  }
  const protocol = loopbackHttp ? "http:" : "https:";
  return new URL(`${protocol}//${source.host}/v1/upload`);
};

const readResponse = (
  response: IncomingMessage,
  resolve: (response: UploadResponse) => void,
  reject: (error: unknown) => void,
): void => {
  const status = response.statusCode;
  assertExists(status, "Turso upload response has no status");
  const chunks: Uint8Array[] = [];
  response.on("data", (chunk: Uint8Array) => chunks.push(chunk));
  response.on("end", () =>
    resolve({
      ok: status >= 200 && status < 300,
      status,
      text: Buffer.concat(chunks).toString("utf8"),
    }),
  );
  response.on("error", reject);
};

const sendDatabaseFile = (
  url: URL,
  path: string,
  token: string,
  size: number,
  signal?: AbortSignal,
): Promise<UploadResponse> =>
  new Promise((resolve, reject) => {
    const options: RequestOptions = {
      headers: {
        Authorization: `Bearer ${token}`,
        Connection: "close",
        "Content-Length": String(size),
      },
      method: "POST",
    };
    if (signal !== undefined) options.signal = signal;
    const request = (url.protocol === "http:" ? httpRequest : httpsRequest)(
      url,
      options,
      (response) => readResponse(response, resolve, reject),
    );
    pipeline(createReadStream(path), request).catch(reject);
  });

/** Stream a SQLite file into a Turso database without holding it in memory. */
export const uploadTursoDatabaseFile = async (
  path: string,
  credentials: DatabaseCredentials,
  signal?: AbortSignal,
): Promise<void> => {
  const info = await Deno.stat(path);
  if (!info.isFile) throw new Error(`Database snapshot is not a file: ${path}`);
  signal?.throwIfAborted();
  const response = await sendDatabaseFile(
    databaseUploadUrl(credentials.dbUrl),
    path,
    credentials.dbToken,
    info.size,
    signal,
  );
  if (!response.ok) {
    requireSuccess(parseApiError(response, "Upload database"));
  }
};
