import { Buffer } from "node:buffer";
import { createReadStream } from "node:fs";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { assertExists } from "@std/assert";
import { once } from "#fp";
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

/** The bare string the same polyfill write task rejects with when the
 * connection is torn down mid-write instead of answering — an abort or a
 * socket close leaves this exact value, never an Error instance. It escaped
 * as an uncaught rejection and cancelled three hosted runs. */
const POLYFILL_RESOURCE_CLOSED = "resource closed";

/** The first stack frame of an error the runtime itself throws from inside
 * its internals. The upload breaks connections under a running Deno.serve
 * server, so both sides can reject an internal task nobody awaits: the
 * node:http client polyfill (`node:`, `ext:deno_node`) and the server's own
 * HTTP and ops internals (`ext:deno_http`, `ext:core`, and the rest of
 * `ext:`). Our code never throws from any of those: a rejection our code
 * creates names one of our own files first, and an internal frame deeper in
 * a stack cannot move the origin. */
const RUNTIME_INTERNAL_FRAME = /^at (?:async )?(?:node:|deno:|ext:)/;

const firstStackFrameIsRuntimeInternal = (stack: string): boolean => {
  const frame = stack
    .split("\n")
    .find((line) => line.trimStart().startsWith("at "));
  return frame !== undefined && RUNTIME_INTERNAL_FRAME.test(frame.trimStart());
};

/** Whether an unhandled rejection is one of the runtime's own defect values
 * from an unawaited internal task. Two carry fixed shapes: the wrapped
 * body-stream TypeError and the bare "resource closed" string. The
 * polyfill's catch can also crash on an op rejection that carries no
 * message — it reads `.message.includes` off a value that has none — and
 * the secondary error it throws then escapes with a foreign message, so the
 * origin on the stack is the only honest test left. A real failure our code
 * rejects never reaches here: our promises are awaited, and an error we
 * build names our own files first. */
const isRuntimeInternalRejection = (reason: unknown): boolean => {
  if (reason === POLYFILL_RESOURCE_CLOSED) return true;
  if (!(reason instanceof Error)) return false;
  if (
    reason instanceof TypeError &&
    reason.message === POLYFILL_BODY_STREAM_ERROR
  ) {
    return true;
  }
  return firstStackFrameIsRuntimeInternal(reason.stack ?? "");
};

/**
 * Ignore the runtime's duplicate rejections, from the first upload onwards.
 *
 * Nothing says when the internal task that broke the write or the connection
 * will surface its rejection, so the watch cannot be narrow about *when*. It
 * is narrow about *what* instead: every value it eats is built by the
 * runtime's own internals and no code of ours can produce one, so a real
 * failure never reaches here.
 */
const watchRuntimeInternalRejections = once(() => {
  globalThis.addEventListener("unhandledrejection", (event) => {
    if (isRuntimeInternalRejection(event.reason)) {
      event.preventDefault();
    }
  });
});

/** The node:http client can swallow the break of an upload's write: the
 * request then never emits "error" or "close", and the server's answer never
 * ends, so the upload waits forever (issue #2556). This deadline makes it
 * settle with an error instead. Ten minutes covers a large snapshot over a
 * slow link. */
const UPLOAD_DEADLINE_MS = 10 * 60_000;

/** The error an interrupted or overdue upload rejects with. */
const abortReason = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  return new Error(
    `Upload aborted: ${reason instanceof Error ? reason.message : String(reason)}`,
  );
};

const sendDatabaseFile = async (
  url: URL,
  path: string,
  token: string,
  size: number,
  signal: AbortSignal,
  transport: DatabaseUploadTransport = secureUploadTransport,
): Promise<UploadResponse> => {
  watchRuntimeInternalRejections();
  const response = Promise.withResolvers<UploadResponse>();
  // A write the polyfill swallowed leaves this promise pending forever, so
  // the caller's signal and the deadline are the only ways it can settle.
  const abort = () => response.reject(abortReason(signal));
  signal.addEventListener("abort", abort, { once: true });
  const file = createReadStream(path);
  const fileClosed = Promise.withResolvers<void>();
  file.once("close", fileClosed.resolve);
  try {
    // A signal can abort between the caller's own check and the listener
    // above, and an already-aborted signal never fires it.
    if (signal.aborted) throw abortReason(signal);
    const options: RequestOptions = {
      headers: {
        Authorization: `Bearer ${token}`,
        Connection: "close",
        "Content-Length": String(size),
      },
      method: "POST",
      signal,
    };
    let responded = false;
    const request = transport.request(url, options, (incoming) => {
      responded = true;
      readResponse(incoming, response.resolve, response.reject);
    });
    // A request can raise "error" more than once — the write breaking, and
    // then the file stopping because of it, which destroys the request with an
    // error of its own. node throws an "error" nothing is listening for, from
    // a place no caller can catch, so this listener stays on for the request's
    // whole life.
    request.on("error", (error) => {
      // Stop the file quietly: destroying it *with* the error would re-raise
      // it as a file error and hide the server's answer below.
      file.destroy();
      // The server can answer (e.g. reject the upload) before the whole body
      // is sent; the write then fails, but the server's answer is the real
      // outcome, so only a write error with no response in flight rejects
      // here.
      if (!responded) response.reject(error);
    });
    file.once("error", request.destroy.bind(request));
    file.once("error", response.reject);
    file.pipe(request);
    return await response.promise;
  } finally {
    signal.removeEventListener("abort", abort);
    file.destroy();
    await fileClosed.promise;
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
  const deadline = AbortSignal.timeout(UPLOAD_DEADLINE_MS);
  const response = await sendDatabaseFile(
    databaseUploadUrl(credentials.dbUrl),
    path,
    credentials.dbToken,
    info.size,
    signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    transport,
  );
  if (!response.ok) {
    requireSuccess(parseApiError(response, "Upload database"));
  }
};
