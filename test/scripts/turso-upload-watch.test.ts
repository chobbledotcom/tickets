// test-groups: run-alone

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { uploadTursoDatabaseFile } from "#scripts/turso-migration-file.ts";
import { withTempDir } from "#test-utils/files.ts";
import {
  earlyAnswerHandler,
  fakeRequest,
  throwFrom,
  uploadCredentials,
  uploadThroughScript,
  withinDeadline,
  withUploadServer,
} from "./turso-upload-harness.ts";

describe("Turso upload watch", () => {
  /** The harness's teardown aborts the still-streaming request through the
   * signal it plants, so the break surfaces as the request's own "error"
   * event. A teardown that breaks the socket instead leaves the runtime's
   * write task rejecting with a bare "resource closed" string — an uncaught
   * error at an unknown location that failed hosted runs. The recorder here
   * prevents a rejection the watch missed and fails the test with its value,
   * so the next escape names itself instead of cancelling the suite. */
  test("the teardown aborts an in-flight upload with no stray rejections", () =>
    withTempDir(async (dir) => {
      const path = `${dir}/database.sqlite`;
      await Deno.writeFile(path, new Uint8Array(32_000_000));

      const uploadRound = () =>
        withUploadServer(earlyAnswerHandler, (dbUrl, transport) =>
          withinDeadline(
            expect(
              uploadTursoDatabaseFile(
                path,
                uploadCredentials(dbUrl),
                undefined,
                transport,
              ),
            ).rejects.toThrow("error writing a body to connection"),
            "the upload",
          ),
        );

      // The watch registers on the first upload, and its listener must sit
      // ahead of the recorder: a rejection it eats then arrives already
      // prevented. One round installs it before recording starts.
      await uploadRound();

      const stray: string[] = [];
      const record = (reason: unknown): void => {
        stray.push(
          reason instanceof Error
            ? `${reason.name}: ${reason.message}\n${reason.stack ?? "(no stack)"}`
            : `${typeof reason}: ${String(reason)}`,
        );
      };
      const onRejection = (event: PromiseRejectionEvent) => {
        // Skip what the watch already ate; record what it missed, then let
        // the assertion below fail with the value.
        if (event.defaultPrevented) return;
        event.preventDefault();
        record(event.reason);
      };
      // The hosted runs report an "uncaught error" with no TAP diagnostic,
      // so a missed rejection and a thrown task look the same there. Record
      // both channels; a real failure still fails the test below.
      const onError = (event: ErrorEvent) => {
        event.preventDefault();
        record(event.error ?? event.message);
      };
      globalThis.addEventListener("unhandledrejection", onRejection);
      globalThis.addEventListener("error", onError);
      try {
        for (let round = 0; round < 5; round += 1) {
          await uploadRound();
        }
        // One macrotask turn lets a rejection from the teardown's abort land
        // while the listener still records it. The runtime dispatches
        // rejections on the platform's own schedule, so no deterministic
        // clock can drive it.
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 0);
        await promise;
      } finally {
        globalThis.removeEventListener("unhandledrejection", onRejection);
        globalThis.removeEventListener("error", onError);
      }
      expect(stray).toEqual([]);
    }));

  // The rejection surfaces whenever the runtime's own internal task ends, so
  // the watch cannot be timed to the upload — it stays up once an upload has
  // run, and earns that by only ever ignoring runtime-internal values.
  test("ignores runtime-internal rejections and nothing else", () =>
    withTempDir(async (dir) => {
      const prevented = (reason: unknown): boolean => {
        const event = new PromiseRejectionEvent("unhandledrejection", {
          cancelable: true,
          promise: Promise.resolve(),
          reason,
        });
        globalThis.dispatchEvent(event);
        return event.defaultPrevented;
      };
      const defect = () =>
        new TypeError("Failed to fetch: request body stream errored");

      // Hold the upload open: the scripted transport never answers. The
      // watch is up by the time the transport runs, so wait for that.
      const started = Promise.withResolvers<void>();
      const request = fakeRequest();
      const upload = uploadThroughScript(dir, request, () => {
        started.resolve();
      });
      await started.promise;

      expect(prevented(defect())).toBe(true);
      expect(
        prevented(new Error("Failed to fetch: request body stream errored")),
      ).toBe(false);
      expect(prevented(new TypeError("some other failure"))).toBe(false);

      request.destroy(new Error("cut mid-upload"));
      await expect(upload).rejects.toThrow("cut mid-upload");
      // Still ignored after the upload settles: a late rejection is exactly
      // the one this watch exists for.
      expect(prevented(defect())).toBe(true);
      expect(prevented(new TypeError("some other failure"))).toBe(false);
      // The same runtime write task rejects with a bare "resource closed"
      // string when the connection is torn down mid-write instead of
      // answering. It is not an Error instance, and hosted runs died on it;
      // the watch eats it and nothing else new.
      expect(prevented("resource closed")).toBe(true);
      expect(prevented(new TypeError("some other failure"))).toBe(false);
      expect(prevented("upload database failed")).toBe(false);
      // The polyfill's own catch crashes when an op rejects with a value
      // that carries no message, and the secondary error it throws from
      // inside its internals escapes with a foreign message. Its first
      // stack frame names the runtime internals; an error our code builds
      // names one of our own files first, and the watch leaves that alone.
      expect(
        prevented(
          throwFrom(
            "Cannot read properties of undefined (reading 'includes')",
            "at node:http:571:12",
          ),
        ),
      ).toBe(true);
      // The upload runs under a Deno.serve server, whose own HTTP task can
      // reject the same way when the teardown closes the connection. Its
      // frames sit in ext:deno_http, not the node polyfill's modules, so
      // every runtime-internal origin must count as the same defect.
      expect(
        prevented(
          throwFrom(
            "connection closed before message completed",
            "at ext:deno_http/01_http.js:482:11",
          ),
        ),
      ).toBe(true);
      expect(
        prevented(
          throwFrom(
            "Cannot read properties of undefined (reading 'includes')",
            "at async ext:core/01_core.js:334:12",
          ),
        ),
      ).toBe(true);
      // An application frame first with an internal frame after it: the
      // origin sits at the first frame, so the watch leaves it alone.
      expect(
        prevented(
          throwFrom(
            "Upload database failed (400): invalid",
            "at file:///scripts/turso-migration-file.ts:208:5",
            "at node:http:571:12",
          ),
        ),
      ).toBe(false);
      expect(
        prevented(
          throwFrom(
            "Upload database failed (400): invalid",
            "at file:///scripts/turso-migration-file.ts:208:5",
            "at ext:deno_http/01_http.js:482:11",
          ),
        ),
      ).toBe(false);
      // An error that carries no stack at all reaches the origin test
      // through its fallback branch. Nothing matches there either, so the
      // watch leaves it alone.
      expect(
        prevented(
          Object.assign(new TypeError("some other failure"), {
            stack: undefined,
          }),
        ),
      ).toBe(false);
      // A stack with no frame lines names no origin either.
      expect(
        prevented(
          Object.assign(new TypeError("some other failure"), {
            stack: "TypeError: some other failure",
          }),
        ),
      ).toBe(false);
    }));
});
