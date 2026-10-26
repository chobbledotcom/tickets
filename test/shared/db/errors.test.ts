import { LibsqlError } from "@libsql/client";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  classifyDatabaseError,
  DATABASE_RETRY,
  databaseErrorFingerprint,
} from "#db/errors.ts";

/**
 * The one classifier and the one retry table. The classifier reads an error's
 * shape — its type, its libsql code, or the `client error (…)` marker in a
 * fetch transport message — and maps it to one kind. The table says how often
 * each kind retries on a read and on a write. The messages are the real ones
 * from the Bugsink events that motivated the rule, with the hosts replaced by
 * examples.
 */
describe("db > error kinds", () => {
  test("the classifier maps the real event messages to their kinds", () => {
    expect(
      classifyDatabaseError(new Error("SQLITE_BUSY: database is locked")),
    ).toBe("locked");
    expect(
      classifyDatabaseError(
        new LibsqlError("Server returned HTTP status 502", "SERVER_ERROR"),
      ),
    ).toBe("upstream-status");
    expect(
      classifyDatabaseError(
        new TypeError(
          "error sending request from 85.208.99.12:41022 for https://mydb.aws-eu-west-1.turso.io/v2/pipeline (203.0.113.7:443): client error (Connect): dns error: failed to lookup address information",
        ),
      ),
    ).toBe("transport-connect");
    expect(
      classifyDatabaseError(
        new TypeError(
          "error sending request from 85.208.99.12:41022 for https://mydb.aws-eu-west-1.turso.io/v2/pipeline (203.0.113.7:443): client error (SendRequest): connection closed before message completed",
        ),
      ),
    ).toBe("transport-send");
    expect(
      classifyDatabaseError(
        new TypeError(
          "error sending request from 85.208.99.12:41022 for https://mydb.bunny.run/v2/pipeline (203.0.113.7:443): client error (SendRequest): http2 error: stream error received: unspecific protocol error detected",
        ),
      ),
    ).toBe("transport-send");
    expect(
      classifyDatabaseError(
        new TypeError(
          "error sending request from 85.208.99.12:41022 for https://mydb.aws-eu-west-1.turso.io/v2/pipeline (203.0.113.7:443): client error (SendRequest): connection error: Connection timed out (os error 110)",
        ),
      ),
    ).toBe("transport-send");
  });

  test("the classifier leaves lookalikes and application errors as other", () => {
    // A plain Error quoting a transient status never passed through the
    // libsql client, so it is not an upstream answer.
    expect(
      classifyDatabaseError(
        new Error("SERVER_ERROR: Server returned HTTP status 502"),
      ),
    ).toBe("other");
    expect(
      classifyDatabaseError(
        new TypeError("Cannot read properties of undefined (reading 'slug')"),
      ),
    ).toBe("other");
  });

  test("the retry table says what replays on a read and on a write", () => {
    expect(DATABASE_RETRY).toEqual({
      locked: { read: "ladder", write: "ladder" },
      other: { read: 0, write: 0 },
      "transport-connect": { read: 1, write: 1 },
      "transport-send": { read: "ladder", write: 0 },
      "upstream-status": { read: "ladder", write: 0 },
    });
  });

  test("a transport report groups by kind and route, another error does not", () => {
    expect(
      databaseErrorFingerprint(
        "transport-send",
        "E_DB_CONNECTION",
        "POST",
        "/payment/webhook",
      ),
    ).toEqual([
      "E_DB_CONNECTION",
      "db-transport",
      "transport-send",
      "POST",
      "/payment/webhook",
    ]);
    expect(
      databaseErrorFingerprint(
        "transport-connect",
        "E_DB_CONNECTION",
        "GET",
        "/t/[redacted]",
      ),
    ).toEqual([
      "E_DB_CONNECTION",
      "db-transport",
      "transport-connect",
      "GET",
      "/t/[redacted]",
    ]);
    expect(
      databaseErrorFingerprint(
        "upstream-status",
        "E_DB_CONNECTION",
        "GET",
        "/",
      ),
    ).toBeUndefined();
    expect(
      databaseErrorFingerprint("other", "E_CDN_REQUEST", "GET", "/"),
    ).toBeUndefined();
  });
});
