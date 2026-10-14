import {
  type Client,
  type Config,
  createClient,
  LibsqlBatchError,
  LibsqlError,
} from "@libsql/client";
import { expandConfig } from "@libsql/core/config";
import { encodeBaseUrl } from "@libsql/core/uri";
import { ResultSetImpl } from "@libsql/core/util";
import {
  ClientError,
  ClosedError,
  type HttpClient,
  openHttp,
  ResponseError,
  Stmt,
} from "@libsql/hrana-client";
import promiseLimit from "promise-limit";
import { wrapExecute } from "#db/libsql-call.ts";
import { isReadSql, sqlOf } from "#db/sql-text.ts";
import { bracket } from "#fp";
import { proxyMembers } from "#shared/proxy-members.ts";

type BatchStatement = Parameters<Client["batch"]>[0][number];

const ERROR_CODES: Readonly<Record<string, string>> = {
  ClosedError: "HRANA_CLOSED_ERROR",
  HttpServerError: "SERVER_ERROR",
  InternalError: "INTERNAL_ERROR",
  ProtocolVersionError: "PROTOCOL_VERSION_ERROR",
  ProtoError: "HRANA_PROTO_ERROR",
};

const errorCode = (error: ClientError): string => {
  if (error instanceof ResponseError && error.code !== undefined)
    return error.code;
  if (error instanceof ClosedError && error.cause instanceof ClientError)
    return errorCode(error.cause);
  return ERROR_CODES[error.name] ?? "UNKNOWN";
};

const mappedClientError = (error: ClientError): LibsqlError =>
  new LibsqlError(error.message, errorCode(error), undefined, undefined, error);

const clientError = (error: unknown): unknown =>
  error instanceof ClientError ? mappedClientError(error) : error;

const toStatement = (statement: BatchStatement): Stmt => {
  const args =
    typeof statement === "string"
      ? undefined
      : Array.isArray(statement)
        ? statement[1]
        : statement.args;
  const result = new Stmt(sqlOf(statement));
  if (args !== undefined) {
    if (Array.isArray(args)) result.bindIndexes(args);
    else
      for (const [name, value] of Object.entries(args))
        result.bindName(name, value);
  }
  return result;
};

/** The separate BEGIN keeps the read on the primary. Queue every operation before
 * the first await so Hrana sends one HTTP request, including the stream close. */
const readPipeline = async (
  client: HttpClient,
  statements: BatchStatement[],
): Promise<ResultSetImpl[]> => {
  const prepared = statements.map(toStatement);
  return bracket(
    () => client.openStream(),
    (stream) => stream.close(),
  )(async (stream) => {
    const begin = stream.run("BEGIN IMMEDIATE");
    const batch = stream.batch(false);
    const rows = prepared.map((statement) => batch.step().query(statement));
    const execution = batch.execute();
    const commit = stream.run("COMMIT");
    stream.closeGracefully();
    // Transport failure can leave row promises pending. Await those only after
    // the batch succeeds, but attach their error handlers before the HTTP reply.
    const settledRows = Promise.allSettled(rows);
    await Promise.allSettled([begin, execution, commit]);
    await begin;
    await execution;
    const results = (await settledRows).map((result, index) => {
      if (result.status === "rejected") {
        const mapped = mappedClientError(result.reason);
        throw new LibsqlBatchError(
          mapped.message,
          index,
          mapped.code,
          mapped.extendedCode,
          mapped.rawCode,
          mapped,
        );
      }
      if (result.value === undefined) {
        throw new LibsqlBatchError(
          "Primary read statement was not executed",
          index,
          "TRANSACTION_CLOSED",
        );
      }
      return result.value;
    });
    await commit;
    return results.map(
      (row) =>
        new ResultSetImpl(
          row.columnNames.map((name) => name ?? ""),
          row.columnDecltypes.map((type) => type ?? ""),
          row.rows,
          row.affectedRowCount,
          row.lastInsertRowid,
        ),
    );
  }).catch((error) => {
    throw clientError(error);
  });
};

/** The fetch the database client configures. The library's HTTP engine hands
 *  it the engine's own Request object, not a native one, and passes no second
 *  argument beyond what a caller supplies. Rebuild the native request from
 *  the wire facts the object carries, read through its own API, so Deno's
 *  fetch sees a request it understands. Forward the call arguments unchanged.
 *  `onDispatch` runs after every await, immediately before the boundary call,
 *  so a caller can reject work whose world moved on while the adapter
 *  suspended. */
export const databaseFetch = async (
  input: Request,
  init?: RequestInit,
  onDispatch?: () => void,
): Promise<Response> => {
  // A protobuf body is bytes, not text. A text read decodes and re-encodes
  // it, and non-UTF-8 sequences change. A bodyless GET must send no body
  // at all: fetch rejects a GET that carries one.
  const headers = new Headers();
  for (const [name, value] of input.headers.entries()) {
    headers.set(name, value);
  }
  const nativeInit: RequestInit = {
    headers,
    method: input.method,
    signal: input.signal,
  };
  if (input.body !== null) nativeInit.body = await input.arrayBuffer();
  const native = new Request(input.url, nativeInit);
  // The explicit init.signal still wins: the boundary's fetch init carries
  // it, and a fetch init signal replaces the request's own.
  onDispatch?.();
  return fetch(native, init);
};

/** Turso's load balancer closes idle keep-alive sockets before Deno's 90-second
 * pool does. A request on such a socket fails with "connection closed before
 * message completed", so the database pool drops idle sockets first. */
const DATABASE_POOL_IDLE_TIMEOUT_MS = 20_000;

/** Keep native writes and local clients. HTTP primary reads share one pipeline.
 * Remote requests use their own connection pool unless the caller passes a
 * `fetch`. */
/** Deno's fetch honours the proxy environment variables. A custom
 *  HttpClient knows no proxy. A deployment with a proxy keeps the default
 *  fetch behavior, and the pool serves direct-egress deployments. */
export const PROXY_ENV_NAMES = [
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
];

export const createDatabaseClient = (callerConfig: Config): Client => {
  const usesProxy = PROXY_ENV_NAMES.some(
    (name) => process.env[name] !== undefined,
  );
  let pool: Deno.HttpClient | undefined;
  const pooledFetch = async (
    input: Request,
    engineInit?: RequestInit,
  ): Promise<Response> => {
    if (!usesProxy) {
      pool ??= Deno.createHttpClient({
        poolIdleTimeout: DATABASE_POOL_IDLE_TIMEOUT_MS,
      });
    }
    const requestPool = pool;
    // The gate reads the body to suspend this callback, and the adapter
    // reads its own clone. One read never consumes the other's body. The
    // adapter suspends again on the clone's body, so the guard — not this
    // wrapper — has the last word at the boundary. A close in any window
    // cleared the slot, and the request is then stale — the caller already
    // saw the client close.
    const engineCopy = input.clone();
    const init: RequestInit & { client?: Deno.HttpClient } =
      requestPool === undefined
        ? { ...engineInit }
        : { ...engineInit, client: requestPool };
    return databaseFetch(engineCopy, init, () => {
      if (client.closed || pool !== requestPool) {
        throw new LibsqlError("The database client is closed", "CLIENT_CLOSED");
      }
    });
  };
  // A caller's fetch: undefined must not erase the pool wrapper. The
  // library then falls back to global fetch with its own Request type,
  // and the boundary fails on it.
  const { fetch: callerFetch = pooledFetch, ...rest } = callerConfig;
  const config: Config = { ...rest, fetch: callerFetch };
  const client = createClient(config);
  if (client.protocol !== "http") return client;
  const expanded = expandConfig(config, true);
  const limit: <T>(work: () => Promise<T>) => Promise<T> = promiseLimit(
    expanded.concurrency,
  );
  const limited =
    <Args extends unknown[], Result>(run: (...args: Args) => Promise<Result>) =>
    (...args: Args): Promise<Result> =>
      limit(() => run(...args));
  let pipeline: HttpClient | undefined;
  const getPipeline = (): HttpClient => {
    if (client.closed)
      throw new LibsqlError("The database client is closed", "CLIENT_CLOSED");
    if (pipeline === undefined) {
      pipeline = openHttp(
        encodeBaseUrl(expanded.scheme, expanded.authority, expanded.path),
        expanded.authToken,
        expanded.fetch,
        expanded.remoteEncryptionKey,
      );
      pipeline.intMode = expanded.intMode;
    }
    return pipeline;
  };
  const resetPipeline = (): void => {
    pipeline?.close();
    pipeline = undefined;
  };
  return proxyMembers(client, {
    batch: async (
      statements: BatchStatement[],
      mode?: Parameters<Client["batch"]>[1],
    ) =>
      limit(() =>
        mode === "write" &&
        statements.every((statement) => isReadSql(sqlOf(statement)))
          ? readPipeline(getPipeline(), statements)
          : client.batch(statements, mode),
      ),
    close: () => {
      resetPipeline();
      client.close();
      pool?.close();
      pool = undefined;
    },
    execute: wrapExecute(client, (_statement, run) => limit(run)),
    executeMultiple: limited(client.executeMultiple.bind(client)),
    migrate: limited(client.migrate.bind(client)),
    reconnect: () => {
      resetPipeline();
      return client.reconnect();
    },
    transaction: limited(client.transaction.bind(client)),
  });
};
