import { assertInstanceOf } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { uploadTursoDatabaseFile } from "#scripts/turso-migration-file.ts";
import {
  expectUploadRejection,
  localUploadFetch,
  readUploadChunk,
  UPLOAD_SIZE,
  uploadCredentials,
  withinDeadline,
  withUploadFile,
  withUploadServer,
} from "./turso-upload-harness.ts";

const expectTransportFailure = (error: unknown): void => {
  assertInstanceOf(error, TypeError);
  expect(error.message).toMatch(/error sending request|error writing a body/);
};

interface PendingResponseUpload {
  cancelledBody: Promise<unknown>;
  controller: AbortController;
  outcome: Promise<unknown>;
}

const withPendingUploadResponse = (
  run: (upload: PendingResponseUpload) => Promise<void>,
): Promise<void> =>
  withUploadFile(async (path) => {
    const controller = new AbortController();
    const receivedHeaders = Promise.withResolvers<void>();
    const cancelledBody = Promise.withResolvers<unknown>();
    await withUploadServer(
      async (request) => {
        await request.arrayBuffer();
        return new Response(
          new ReadableStream({
            cancel(reason) {
              cancelledBody.resolve(reason);
            },
            start(body) {
              body.enqueue(new TextEncoder().encode("unfinished"));
            },
          }),
          { status: 400 },
        );
      },
      async (dbUrl, fetcher) => {
        const outcome = uploadTursoDatabaseFile(
          path,
          uploadCredentials(dbUrl),
          controller.signal,
          async (input, init) => {
            const response = await fetcher(input, init);
            receivedHeaders.resolve();
            return response;
          },
        ).catch((error: unknown) => error);
        try {
          await withinDeadline(receivedHeaders.promise, "Response headers");
          await run({
            cancelledBody: cancelledBody.promise,
            controller,
            outcome,
          });
        } finally {
          controller.abort();
          await outcome;
        }
      },
    );
  });

describe("Turso upload lifecycle", () => {
  test("ends a stalled wait even when the upload clock is frozen", async () => {
    const schedule = globalThis.setTimeout;
    using time = new FakeTime();
    const work = Promise.withResolvers<void>();
    const outcome = withinDeadline(work.promise, "Stalled upload", 0).catch(
      (error: unknown) => error,
    );
    schedule(work.resolve, 0);
    const error = await outcome;
    assertInstanceOf(error, Error);
    expect(error.message).toContain("Stalled upload");
  });

  test("rejects an early answer without a timeout or stray rejection", () =>
    withUploadFile(async (path) => {
      let received = 0;
      await expectUploadRejection(
        path,
        async (request) => {
          received = await readUploadChunk(request);
          return new Response("invalid", { status: 400 });
        },
        (error) => {
          if (error instanceof TypeError) {
            expectTransportFailure(error);
          } else {
            assertInstanceOf(error, Error);
            expect(error.message).toBe("Upload database failed (400): invalid");
          }
        },
      );
      expect(received).toBeLessThan(UPLOAD_SIZE);
    }));

  test("rejects a connection that closes before any answer", () =>
    withUploadFile(async (path) => {
      using listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const server = (async () => {
        using connection = await listener.accept();
        const buffer = new Uint8Array(64 * 1024);
        let received = 0;
        while (received < 2_000_000) {
          const count = await connection.read(buffer);
          if (count === null) throw new Error("Upload ended before the cut");
          received += count;
        }
        return received;
      })();
      const outcome = await withinDeadline(
        uploadTursoDatabaseFile(
          path,
          uploadCredentials(`https://127.0.0.1:${listener.addr.port}`),
          undefined,
          localUploadFetch,
        ).catch((error: unknown) => error),
        "Dropped upload",
      );
      expectTransportFailure(outcome);
      expect(await server).toBeLessThan(UPLOAD_SIZE);
    }));

  for (const reason of [new Error("stop now"), "stop now"]) {
    test(`aborts a request under backpressure with a ${typeof reason} reason`, () =>
      withUploadFile(async (path) => {
        const controller = new AbortController();
        const started = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        await withUploadServer(
          async (request) => {
            await readUploadChunk(request);
            started.resolve();
            await release.promise;
            return new Response();
          },
          async (dbUrl, fetcher) => {
            const outcome = uploadTursoDatabaseFile(
              path,
              uploadCredentials(dbUrl),
              controller.signal,
              fetcher,
            ).catch((error: unknown) => error);
            try {
              await withinDeadline(started.promise, "Upload body");
              controller.abort(reason);
              const error = await withinDeadline(outcome, "Cancelled upload");
              assertInstanceOf(error, Error);
              expect(error.message).toBe("Upload aborted: stop now");
            } finally {
              controller.abort();
              release.resolve();
              await outcome;
            }
          },
        );
      }));
  }

  test("aborts after response headers arrive but before the response ends", () =>
    withPendingUploadResponse(
      async ({ controller, outcome, cancelledBody }) => {
        controller.abort(new Error("stop the response"));
        const error = await withinDeadline(outcome, "Cancelled response");
        assertInstanceOf(error, Error);
        expect(error.message).toBe("Upload aborted: stop the response");
        await withinDeadline(cancelledBody, "Response cancellation");
      },
    ));

  test("keeps the deadline active until the response body ends", async () => {
    using time = new FakeTime();
    await withPendingUploadResponse(async ({ outcome, cancelledBody }) => {
      let settled = false;
      const observed = outcome.finally(() => {
        settled = true;
      });
      await time.tickAsync(599_999);
      expect(settled).toBe(false);
      await time.tickAsync(1);
      const error = await withinDeadline(observed, "Upload deadline");
      assertInstanceOf(error, Error);
      expect(error.message).toBe(
        "Upload aborted: Upload exceeded the 10-minute deadline",
      );
      await withinDeadline(cancelledBody, "Response cancellation");
    });
  });
});
