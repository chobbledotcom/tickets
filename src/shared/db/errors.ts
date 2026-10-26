/**
 * The one classifier for the errors the database layer raises, and the one
 * table that says which of them retry.
 *
 * Deno's fetch reports a failed or dropped database connection with a raw
 * TypeError. No HTTP status exists at that point. @libsql/hrana-client passes
 * the TypeError through unchanged, so the message text is the only signal. It
 * names the phase of the failure: `client error (Connect)` before the request
 * left the edge, `client error (SendRequest)` after the request was sent.
 */

import { LibsqlError } from "@libsql/client";

/**
 * The kind of a failed database round trip:
 * - `locked` — SQLite's single write lock was contended (SQLITE_BUSY). The
 *   statement never ran, so any statement can replay it.
 * - `upstream-status` — the database server or its gateway answered a
 *   fleeting HTTP 421/502/503/504, surfaced as a SERVER_ERROR LibsqlError.
 * - `transport-connect` — a fetch `client error (Connect)` failure (DNS,
 *   TCP, TLS). No request left the edge, so a replay cannot double-apply.
 * - `transport-send` — a fetch `client error (SendRequest)` failure. The
 *   request reached the network, so the server already ran the statement.
 * - `other` — every other error, database or not.
 */
export type DatabaseErrorKind =
  | "locked"
  | "upstream-status"
  | "transport-connect"
  | "transport-send"
  | "other";

/** SQLite has a single writer, so a contended write surfaces as SQLITE_BUSY.
 *  The local driver throws "database is locked" at once when a bare statement
 *  cannot take the lock. An interactive transaction's commit throws "cannot
 *  commit transaction - SQL statements in progress" when another writer still
 *  holds the connection. Both messages carry SQLITE_BUSY. */
const LOCKED_MESSAGE_RE = /SQLITE_BUSY|database is locked/i;

/** The libsql server briefly rejects a fresh connection (421), or its gateway
 *  times out or turns unreachable (502/503/504). The client surfaces each as
 *  a SERVER_ERROR LibsqlError that names the HTTP status. A read earns a
 *  retry. A genuine client or server fault (400/500) earns none, because a
 *  replay only repeats it. */
const TRANSIENT_UPSTREAM_STATUS_RE =
  /Server returned HTTP status (?:421|502|503|504)\b/;

/** reqwest's marker for a failure before the request left the edge. The
 *  message names the cause: a DNS failure, a refused TCP connect, or a TLS
 *  handshake failure. */
const CONNECT_MARKER = "client error (Connect)";

/** reqwest's marker for a failure after the request was sent. The message
 *  names the cause: a pooled keep-alive connection the server closed before
 *  the answer came, an HTTP/2 stream reset, or a timed-out connection. The
 *  first message reads "connection closed before message completed". */
const SEND_REQUEST_MARKER = "client error (SendRequest)";

/**
 * Map any error to its {@link DatabaseErrorKind}. This one function reads an
 * error's shape. The retry table and the request error log both call it.
 *
 * The classifier matches the `client error (…)` markers against the message
 * text, because that is the only signal the fetch transport gives. The real
 * event message reads "error sending request from <edge-ip>:<port> for
 * https://<db-host>/v2/pipeline (<ip>:443): client error (SendRequest):
 * connection closed before message completed". The Connect twin starts
 * "client error (Connect): dns error".
 */
export const classifyDatabaseError = (error: unknown): DatabaseErrorKind => {
  if (error instanceof Error && LOCKED_MESSAGE_RE.test(error.message)) {
    return "locked";
  }
  if (
    error instanceof LibsqlError &&
    error.code === "SERVER_ERROR" &&
    TRANSIENT_UPSTREAM_STATUS_RE.test(error.message)
  ) {
    return "upstream-status";
  }
  if (error instanceof TypeError) {
    if (error.message.includes(CONNECT_MARKER)) return "transport-connect";
    if (error.message.includes(SEND_REQUEST_MARKER)) return "transport-send";
  }
  return "other";
};

/** Whether the database layer raised the error. True for any LibsqlError (the
 *  client wraps every database answer), for a contended write lock, and for a
 *  fetch transport failure. An application error is never a database error,
 *  so the request layer logs it under its own code. */
export const isDatabaseError = (error: unknown): boolean =>
  error instanceof LibsqlError || classifyDatabaseError(error) !== "other";

/** The retry count for one kind and mode. The value "ladder" walks the
 *  database's whole transient backoff ladder. A number is a fixed retry
 *  count. 0 propagates the error at once. */
export type RetryCount = "ladder" | number;

/**
 * The one retry table: how often each kind retries on a read and on a write.
 *
 * A read is always safe to replay, so every transient kind retries on one. A
 * write can only replay a failure that provably stopped before the server ran
 * the statement. A statement that loses the lock never ran. A Connect failure
 * never left the edge. An upstream status or a SendRequest failure can arrive
 * after the write landed, so a write never replays either. The owner decided
 * that a Connect failure earns a single retry, not the whole ladder. A DNS
 * failure costs seconds per attempt. The 503 page refreshes after two
 * seconds.
 */
export const DATABASE_RETRY: Record<
  DatabaseErrorKind,
  { read: RetryCount; write: RetryCount }
> = {
  locked: { read: "ladder", write: "ladder" },
  other: { read: 0, write: 0 },
  "transport-connect": { read: 1, write: 1 },
  "transport-send": { read: "ladder", write: 0 },
  "upstream-status": { read: "ladder", write: 0 },
};

/**
 * The fingerprint that groups a transport report by kind and route, or
 * undefined for any other error, which groups by its own stack.
 *
 * A transport message carries the edge IP, the source port, and the database
 * host. Grouping by that text makes one bug-catcher issue per event. The
 * fingerprint leaves those facts out, so one issue covers each transport kind
 * and route.
 */
export const databaseErrorFingerprint = (
  kind: DatabaseErrorKind,
  code: string,
  method: string,
  route: string,
): string[] | undefined =>
  kind === "transport-connect" || kind === "transport-send"
    ? [code, "db-transport", kind, method, route]
    : undefined;
