/**
 * The upload harness the Turso migration-file suites share: a local
 * Deno.serve upload server with an aborting teardown, scripted transports,
 * and the padded early answer that makes the polyfill's internal write task
 * fail. Kept out of the suites so the upload behaviour and the rejection
 * watch each read as their own file.
 */

import {
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { Writable } from "node:stream";
import { assertExists } from "@std/assert";
import { expect } from "@std/expect";
import { join } from "@std/path";
import {
  type DatabaseUploadTransport,
  uploadTursoDatabaseFile,
} from "#scripts/turso-migration-file.ts";
import { TEST_TURSO_CREDENTIALS } from "#test-utils/turso-api.ts";

/** Credentials that point an upload at a local test server. */
export const uploadCredentials = (dbUrl: string) => ({
  ...TEST_TURSO_CREDENTIALS,
  dbUrl,
});

/** How long a wedged upload or a stuck server shutdown may hold a suite
 * open. A genuine 32 MB loopback upload settles in well under a second. */
export const UPLOAD_DEADLINE_MS = 30_000;

/** The caller's own deadline for one upload round. Shorter than
 * {@link UPLOAD_DEADLINE_MS} so a wedged upload settles through the
 * product's abort path, and the failure names that outcome. */
export const TEST_UPLOAD_SIGNAL_MS = 10_000;

/** Reject with a named failure when `work` has not settled in time. The
 * upload can wedge: the request never emits "error" or "close", so the
 * promise never settles and the server's shutdown then waits on the open
 * connection forever (issue #2556). Without this bound the whole hosted
 * job hangs until the runner's timeout, and nothing names the cause. A real
 * timer: the wedge is the platform's own scheduling of the socket close and
 * the polyfill's write task. */
export const withinDeadline = <T>(
  work: Promise<T>,
  label: string,
): Promise<T> => {
  const deadline = Promise.withResolvers<T>();
  const timer = setTimeout(
    () =>
      deadline.reject(
        new Error(
          `${label} did not settle within ${UPLOAD_DEADLINE_MS}ms; the upload wedged (issue #2556).`,
        ),
      ),
    UPLOAD_DEADLINE_MS,
  );
  return Promise.race([work, deadline.promise]).finally(() =>
    clearTimeout(timer),
  );
};

/** Run the upload against a local server, then abort every request it left
 * streaming and shut the server down. A server that answers before reading
 * the body leaves the client still streaming after the upload has settled.
 * Aborting those requests here raises the break as each request's own
 * "error" event, which the upload's handler consumes. A socket-level destroy
 * instead races the polyfill's write task, which rejects with a bare
 * "resource closed" string no watch may eat — the uncaught error that failed
 * hosted runs at an unknown location. The shutdown is bounded: a wedged
 * request leaves the connection open, and a graceful shutdown would wait on
 * it forever, so the wedge fails the test instead of hanging the job. */
export const withUploadServer = async (
  handler: (request: Request) => Response | Promise<Response>,
  run: (dbUrl: string, transport: DatabaseUploadTransport) => Promise<void>,
): Promise<void> => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", onListen: () => {}, port: 0 },
    handler,
  );
  const address = server.addr;
  if (!("port" in address)) throw new Error("Expected a network address");
  const controllers: AbortController[] = [];
  const transport: DatabaseUploadTransport = {
    request: (url, options, receive) => {
      expect(url.protocol).toBe("https:");
      const localUrl = new URL(url);
      localUrl.protocol = "http:";
      const controller = new AbortController();
      // The caller's own signal keeps working: a combined signal aborts the
      // request when either side fires.
      options.signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal;
      controllers.push(controller);
      return httpRequest(localUrl, options, receive);
    },
  };
  try {
    await run(`https://127.0.0.1:${address.port}`, transport);
  } finally {
    for (const controller of controllers) controller.abort();
    await withinDeadline(server.shutdown(), "the upload server shutdown");
  }
};

/** The answer a server sends when it rejects an upload without reading the
 * whole body. The body is huge, so the client is still busy with it when the
 * write breaks: the failed write then lands inside the response processing,
 * which is the order that makes the polyfill's internal task reject. The
 * message inside stays short. */
export const earlyAnswerBody = JSON.stringify({
  message: "invalid",
  pad: "x".repeat(8 * 1024 * 1024),
});

/** The server handler both early-answer tests share: read one chunk so the
 * socket stays alive until the answer is on the wire, then answer with the
 * padded rejection body while the write is still running. */
export const earlyAnswerHandler = async (
  request: Request,
): Promise<Response> => {
  const body = request.body;
  assertExists(body, "Expected an upload body");
  const reader = body.getReader();
  await reader.read();
  return new Response(earlyAnswerBody, { status: 400 });
};

/** Upload the file at `path` to a server that answers with `handler`, and
 * expect the upload to reject with `match`. */
export const expectUploadRejection = (
  path: string,
  handler: (request: Request) => Response | Promise<Response>,
  match: string | RegExp,
): Promise<void> =>
  withUploadServer(handler, (dbUrl, transport) =>
    withinDeadline(
      expect(
        uploadTursoDatabaseFile(
          path,
          uploadCredentials(dbUrl),
          AbortSignal.timeout(TEST_UPLOAD_SIGNAL_MS),
          transport,
        ),
      ).rejects.toThrow(match),
      "the upload",
    ),
  );

/** A request stub that swallows the piped file bytes. */
export const fakeRequest = (): Writable =>
  new Writable({ write: (_chunk, _encoding, done) => done() });

/** An error whose stack frames sit at `frames`, the way the runtime's own
 * internals and our own files each stamp their errors. */
export const throwFrom = (message: string, ...frames: string[]): TypeError => {
  const error = new TypeError(message);
  error.stack = `TypeError: ${message}\n    ${frames.join("\n    ")}`;
  return error;
};

/** A transport that plays a scripted sequence of events once the upload
 * starts, instead of talking to a real server. */
export const scriptedTransport = (
  request: Writable,
  play: (receive: (response: IncomingMessage) => void) => void,
): DatabaseUploadTransport => ({
  request: (_url, _options, receive) => {
    queueMicrotask(() => play(receive));
    return request as unknown as ClientRequest;
  },
});

/** Upload a small file through a scripted transport and return the result. */
export const uploadThroughScript = async (
  dir: string,
  request: Writable,
  play: (receive: (response: IncomingMessage) => void) => void,
): Promise<void> => {
  const path = join(dir, "database.sqlite");
  await Deno.writeTextFile(path, "sqlite bytes");
  await uploadTursoDatabaseFile(
    path,
    TEST_TURSO_CREDENTIALS,
    undefined,
    scriptedTransport(request, play),
  );
};
