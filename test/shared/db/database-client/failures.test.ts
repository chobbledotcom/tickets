import { LibsqlBatchError, LibsqlError } from "@libsql/client";
import {
  ClosedError,
  InternalError,
  ProtocolVersionError,
} from "@libsql/hrana-client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";
import {
  hranaBatchReply,
  hranaChangedReply,
  hranaTestDatabase,
} from "#test-utils/hrana.ts";

for (const fault of ["begin", "select", "commit"] as const) {
  test(`rejects a ${fault} failure without a partial result`, async () => {
    using remote = hranaTestDatabase({ fault });
    const result = remote.client.batch(["SELECT 1", "SELECT 2"], "write");
    await expect(result).rejects.toBeInstanceOf(LibsqlError);
    await expect(result).rejects.toMatchObject({
      code: "SQLITE_ERROR",
      message: expect.stringContaining(`forced ${fault} failure`),
    });
    expect(remote.requests).toEqual([
      ["BEGIN IMMEDIATE", "batch", "COMMIT", "close"],
    ]);
  });
}

test("preserves the failed statement index and provider error", async () => {
  using remote = hranaTestDatabase({
    select: (sql) => {
      if (sql === "SELECT missing") throw new Error("no such column: missing");
      return Promise.resolve(emptyResultSet());
    },
  });
  const result = remote.client.batch(
    ["SELECT 1", "SELECT missing", "SELECT 3"],
    "write",
  );
  await expect(result).rejects.toBeInstanceOf(LibsqlBatchError);
  await expect(result).rejects.toMatchObject({
    cause: expect.any(LibsqlError),
    code: "SQLITE_ERROR",
    extendedCode: undefined,
    rawCode: undefined,
    statementIndex: 1,
  });
});

for (const index of [0, 1, 2, 3]) {
  test(`rejects an omitted pipeline response at position ${index}`, async () => {
    using remote = hranaTestDatabase({
      reply: hranaChangedReply((body) => {
        body.results.splice(index, 1);
      }),
    });
    await expect(
      remote.client.batch(["SELECT 1"], "write"),
    ).rejects.toMatchObject({
      code: "HRANA_PROTO_ERROR",
      message: expect.stringContaining("number of pipeline results"),
    });
    expect(remote.requests).toHaveLength(1);
  });
}

for (const missing of ["null", "absent"] as const) {
  test(`rejects a row step that is ${missing} at its original index`, async () => {
    using remote = hranaTestDatabase({
      reply: hranaChangedReply((body) => {
        body.results[1] = hranaBatchReply(
          [
            { affected_row_count: 0, cols: [], rows: [] },
            ...(missing === "null" ? [null] : []),
          ],
          [null, null],
        );
      }),
    });
    const result = remote.client.batch(["SELECT 1", "SELECT 2"], "write");
    await expect(result).rejects.toBeInstanceOf(LibsqlBatchError);
    await expect(result).rejects.toMatchObject({
      code: "TRANSACTION_CLOSED",
      message: expect.stringContaining(
        "Primary read statement was not executed",
      ),
      statementIndex: 1,
    });
  });
}

for (const code of [undefined, "SQLITE_BUSY", "SQLITE_CONSTRAINT_UNIQUE"]) {
  test(`preserves the provider error code ${code ?? "UNKNOWN"}`, async () => {
    using remote = hranaTestDatabase({
      reply: hranaChangedReply((body) => {
        body.results[1] = hranaBatchReply(
          [null],
          [{ code, message: "Provider refused the statement" }],
        );
      }),
    });
    await expect(
      remote.client.batch(["SELECT 1"], "write"),
    ).rejects.toMatchObject({
      cause: expect.any(LibsqlError),
      code: code ?? "UNKNOWN",
      statementIndex: 0,
    });
  });
}

test("rejects conflicting row success and error replies", async () => {
  using remote = hranaTestDatabase({
    reply: hranaChangedReply((body) => {
      body.results[1] = hranaBatchReply(
        [{ affected_row_count: 0, cols: [], rows: [] }],
        [{ code: "SQLITE_ERROR", message: "Failed" }],
      );
    }),
  });
  await expect(
    remote.client.batch(["SELECT 1"], "write"),
  ).rejects.toMatchObject({
    code: "HRANA_PROTO_ERROR",
    message: expect.stringContaining("both result and error"),
    statementIndex: 0,
  });
});

test("rejects a failure of the whole query batch", async () => {
  using remote = hranaTestDatabase({
    reply: hranaChangedReply((body) => {
      body.results[1] = {
        error: { code: "SQLITE_BUSY", message: "Batch refused" },
        type: "error",
      };
    }),
  });
  await expect(
    remote.client.batch(["SELECT 1"], "write"),
  ).rejects.toMatchObject({ code: "SQLITE_BUSY" });
});

for (const response of [
  { type: "unrecognised" },
  { response: { type: "close" }, type: "ok" },
  { response: { result: {}, type: "batch" }, type: "ok" },
  {
    response: {
      result: {
        step_errors: [null],
        step_results: [{ affected_row_count: "zero", cols: [], rows: [] }],
      },
      type: "batch",
    },
    type: "ok",
  },
  {
    response: {
      result: {
        step_errors: [null],
        step_results: [
          {
            affected_row_count: 0,
            cols: [{}],
            rows: [[{ type: "unknown" }]],
          },
        ],
      },
      type: "batch",
    },
    type: "ok",
  },
]) {
  test(`rejects a malformed query response: ${JSON.stringify(response)}`, async () => {
    using remote = hranaTestDatabase({
      reply: hranaChangedReply((body) => {
        body.results[1] = response;
      }),
    });
    await expect(
      remote.client.batch(["SELECT 1"], "write"),
    ).rejects.toMatchObject({ code: "HRANA_PROTO_ERROR" });
  });
}

test("preserves a JSON parser error", async () => {
  using remote = hranaTestDatabase({ reply: () => new Response("{") });
  await expect(
    remote.client.batch(["SELECT 1"], "write"),
  ).rejects.toBeInstanceOf(SyntaxError);
});

test("preserves a transport failure without an automatic retry", async () => {
  const error = new TypeError("Connection lost");
  let calls = 0;
  using remote = hranaTestDatabase({
    config: {
      fetch: () => {
        calls++;
        return Promise.reject(error);
      },
    },
  });
  await expect(remote.client.batch(["SELECT 1"], "write")).rejects.toBe(error);
  expect(calls).toBe(1);
});

for (const [error, code] of [
  [new ClosedError("Stream closed", undefined), "HRANA_CLOSED_ERROR"],
  [new InternalError("Invalid client state"), "INTERNAL_ERROR"],
  [new ProtocolVersionError("Protocol refused"), "PROTOCOL_VERSION_ERROR"],
] as const) {
  test(`preserves the transport error ${code}`, async () => {
    using remote = hranaTestDatabase({
      config: { fetch: () => Promise.reject(error) },
    });
    await expect(
      remote.client.batch(["SELECT 1"], "write"),
    ).rejects.toMatchObject({ cause: error, code });
  });
}

test("rejects an unsafe returned integer without a partial result", async () => {
  using remote = hranaTestDatabase({
    select: () =>
      Promise.resolve({
        ...emptyResultSet(),
        columns: ["large"],
        columnTypes: ["INTEGER"],
        rows: [
          { 0: 9223372036854775807n, large: 9223372036854775807n, length: 1 },
        ],
      }),
  });
  await expect(
    remote.client.batch(["SELECT 1"], "write"),
  ).rejects.toBeInstanceOf(RangeError);
});

for (const value of [
  Number.POSITIVE_INFINITY,
  Number.NaN,
  9223372036854775808n,
]) {
  test(`refuses invalid argument ${String(value)} before HTTP work`, async () => {
    using remote = hranaTestDatabase();
    await expect(
      remote.client.batch([["SELECT ?", [value]]], "write"),
    ).rejects.toBeInstanceOf(RangeError);
    expect(remote.requests).toEqual([]);
    expect(await remote.client.batch(["SELECT 1"], "write")).toHaveLength(1);
  });
}

test("rejects HTTP 503 as SERVER_ERROR", async () => {
  using remote = hranaTestDatabase({
    reply: () => new Response("Unavailable", { status: 503 }),
  });
  const result = remote.client.batch(["SELECT 1"], "write");
  await expect(result).rejects.toBeInstanceOf(LibsqlError);
  await expect(result).rejects.toMatchObject({
    code: "SERVER_ERROR",
    message: expect.stringContaining("503"),
  });
  expect(remote.requests).toHaveLength(1);
});

for (const action of ["close", "reconnect"] as const) {
  test(`${action} rejects work before the first HTTP request`, async () => {
    using remote = hranaTestDatabase();
    const pending = remote.client.batch(["SELECT 1"], "write");
    remote.client[action]();
    await expect(pending).rejects.toMatchObject({
      code: "UNKNOWN",
      message: expect.stringContaining("closed"),
    });
    expect(remote.requests).toEqual([]);
    remote.client.reconnect();
    expect(await remote.client.batch(["SELECT 2"], "write")).toHaveLength(1);
  });
}

test("uses a fresh stream after an HTTP 503 failure", async () => {
  let attempts = 0;
  using remote = hranaTestDatabase({
    reply: (body) => {
      attempts++;
      return attempts === 1
        ? new Response(null, { status: 503 })
        : Response.json(body);
    },
  });
  await expect(
    remote.client.batch(["SELECT 1"], "write"),
  ).rejects.toMatchObject({ code: "SERVER_ERROR" });
  expect(await remote.client.batch(["SELECT 2"], "write")).toHaveLength(1);
  expect(attempts).toBe(2);
  expect(remote.envelopes.map((envelope) => envelope.baton)).toEqual([
    undefined,
    undefined,
  ]);
  expect(remote.requests).toEqual(
    Array.from({ length: 2 }, () => [
      "BEGIN IMMEDIATE",
      "batch",
      "COMMIT",
      "close",
    ]),
  );
});
