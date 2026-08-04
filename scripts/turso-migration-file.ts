import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
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
  signal?: AbortSignal,
): Promise<void> =>
  checkLocalSnapshot(path, factory, TURSO_FILE_REQUIREMENTS, signal);

interface UploadResponse {
  ok: boolean;
  status: number;
  text: string;
}

export interface DatabaseUploadTransport {
  request(
    url: URL,
    options: RequestOptions,
    receive: (response: IncomingMessage) => void,
  ): ClientRequest;
}

const secureUploadTransport: DatabaseUploadTransport = {
  request: httpsRequest,
};

const databaseUploadUrl = (dbUrl: string): URL => {
  const source = new URL(dbUrl);
  if (source.protocol !== "libsql:" && source.protocol !== "https:") {
    throw new Error("Turso database URL must use TLS");
  }
  return new URL(`https://${source.host}/v1/upload`);
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

/** The error node:http's client throws inside an internal async task nobody
 * awaits when the server closes the connection while the body is still being
 * sent (deno ext/node polyfill, `ClientRequest._writeHeader`). The request
 * also emits a normal "error" event for the failed write, so the upload still
 * rejects with a real error; the watch below only stops the duplicate
 * internal rejection from crashing the process. */
const POLYFILL_BODY_STREAM_ERROR =
  "Failed to fetch: request body stream errored";

/** Ignore node:http's duplicate rejection while an upload is in flight.
 * Returns a function that stands the watch down again, so an unrelated
 * request failing the same way after the upload still fails loudly. */
const watchPolyfillBodyStreamDefect = (): (() => void) => {
  const ignoreDefect = (event: PromiseRejectionEvent) => {
    if (
      event.reason instanceof TypeError &&
      event.reason.message === POLYFILL_BODY_STREAM_ERROR
    ) {
      event.preventDefault();
    }
  };
  globalThis.addEventListener("unhandledrejection", ignoreDefect);
  return () =>
    globalThis.removeEventListener("unhandledrejection", ignoreDefect);
};

const sendDatabaseFile = async (
  url: URL,
  path: string,
  token: string,
  size: number,
  signal?: AbortSignal,
  transport: DatabaseUploadTransport = secureUploadTransport,
): Promise<UploadResponse> => {
  const standDown = watchPolyfillBodyStreamDefect();
  const response = Promise.withResolvers<UploadResponse>();
  const options: RequestOptions = {
    headers: {
      Authorization: `Bearer ${token}`,
      Connection: "close",
      "Content-Length": String(size),
    },
    method: "POST",
  };
  if (signal !== undefined) options.signal = signal;
  let responded = false;
  const request = transport.request(url, options, (incoming) => {
    responded = true;
    readResponse(incoming, response.resolve, response.reject);
  });
  const file = createReadStream(path);
  const fileClosed = Promise.withResolvers<void>();
  file.once("close", fileClosed.resolve);
  // A request error stops the file quietly — destroying it with the error
  // would re-raise it as a file error and hide the server's answer below.
  request.once("error", () => file.destroy());
  // The server can answer (e.g. reject the upload) before the whole body is
  // sent; the write then fails, but the server's answer is the real outcome,
  // so only a write error with no response in flight rejects here.
  request.once("error", (error) => {
    if (!responded) response.reject(error);
  });
  file.once("error", request.destroy.bind(request));
  file.once("error", response.reject);
  file.pipe(request);
  try {
    return await response.promise;
  } finally {
    file.destroy();
    await fileClosed.promise;
    // The duplicate rejection surfaces at the end of the task that broke the
    // write, so wait one timer turn before standing the watch down.
    await new Promise((resolve) => setTimeout(resolve, 0));
    standDown();
  }
};

/** Stream a SQLite file into a Turso database without holding it in memory. */
export const uploadTursoDatabaseFile = async (
  path: string,
  credentials: DatabaseCredentials,
  signal?: AbortSignal,
  transport?: DatabaseUploadTransport,
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
    transport,
  );
  if (!response.ok) {
    requireSuccess(parseApiError(response, "Upload database"));
  }
};
