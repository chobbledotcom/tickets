import { assertExists } from "@std/assert";
import { uploadTursoDatabaseFile } from "#scripts/turso-migration-file.ts";
import { withTempDir } from "#test-utils/files.ts";
import { TEST_TURSO_CREDENTIALS } from "#test-utils/turso-api.ts";

export const uploadCredentials = (dbUrl: string) => ({
  ...TEST_TURSO_CREDENTIALS,
  dbUrl,
});

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

/** Fail a stalled socket operation instead of an indefinite wait. */
export const withinDeadline = <T>(
  work: Promise<T>,
  label: string,
  timeoutMs = 30_000,
): Promise<T> => {
  const deadline = Promise.withResolvers<T>();
  const timer = realSetTimeout(
    () =>
      deadline.reject(new Error(`${label} did not settle within ${timeoutMs}ms`)),
    timeoutMs,
  );
  return Promise.race([work, deadline.promise]).finally(() =>
    realClearTimeout(timer),
  );
};

/** Keep the production URL and headers, but use HTTP on the local socket. */
export const localUploadFetch: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  url.protocol = "http:";
  return fetch(url, init);
};

export const withUploadServer = async (
  handler: (request: Request) => Response | Promise<Response>,
  run: (dbUrl: string, fetcher: typeof fetch) => Promise<void>,
): Promise<void> => {
  const server = Deno.serve(
    { hostname: "127.0.0.1", onListen: () => {}, port: 0 },
    handler,
  );
  try {
    await run(`https://127.0.0.1:${server.addr.port}`, localUploadFetch);
  } finally {
    await withinDeadline(server.shutdown(), "Upload server shutdown");
  }
};

export const UPLOAD_SIZE = 32_000_000;

export const withUploadFile = (
  run: (path: string) => Promise<void>,
): Promise<void> =>
  withTempDir(async (dir) => {
    const path = `${dir}/database.sqlite`;
    await Deno.writeFile(path, new Uint8Array(UPLOAD_SIZE));
    await run(path);
  });

/** Read one chunk, then leave the rest for the interrupted client to release. */
export const readUploadChunk = async (request: Request): Promise<number> => {
  const body = request.body;
  assertExists(body, "Expected an upload body");
  const reader = body.getReader();
  try {
    const { value } = await reader.read();
    assertExists(value, "Expected upload bytes");
    return value.byteLength;
  } finally {
    reader.releaseLock();
  }
};

export const expectUploadRejection = async (
  path: string,
  handler: (request: Request) => Response | Promise<Response>,
  check: (error: unknown) => void,
): Promise<void> => {
  await withUploadServer(handler, async (dbUrl, fetcher) => {
    const outcome = await withinDeadline(
      uploadTursoDatabaseFile(
        path,
        uploadCredentials(dbUrl),
        undefined,
        fetcher,
      ).catch((error: unknown) => error),
      "Upload",
    );
    check(outcome);
  });
};
