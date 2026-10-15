import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { CliError } from "#cli/errors.ts";
import { type RunDeps, runApi } from "#cli/run.ts";
import type { AdminApiRequest } from "#shared/admin-api-client.ts";
import {
  recordingTransport,
  runDeps,
  testTable,
} from "#test-utils/cli-table.ts";
import { says } from "#test-utils/says.ts";

describe("CLI run", () => {
  test("writes one JSON document to stdout and nothing to stderr", async () => {
    const { transport } = recordingTransport({ gadgets: [{ id: 1 }] });
    const result = await runApi(
      ["list", "gadgets"],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(0);
    expect(result.err).toBeUndefined();
    expect(JSON.parse(result.out ?? "")).toEqual({ gadgets: [{ id: 1 }] });
    expect(result.out?.endsWith("\n")).toBe(true);
  });

  test("answers a describe with the table's resources and no request", async () => {
    const { requests, transport } = recordingTransport({});
    const result = await runApi(
      ["describe", "gadgets"],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(0);
    expect(result.err).toBeUndefined();
    const answer = JSON.parse(result.out ?? "");
    expect(Object.keys(answer.resources)).toEqual(["gadgets"]);
    expect(answer.resources.gadgets.label).toBe("Gadget");
    expect(requests).toEqual([]);
  });

  test("maps the client's statuses to the contract's exit codes", async () => {
    const cases: { expected: number; kind: string; status: number }[] = [
      { expected: 3, kind: "validation", status: 400 },
      { expected: 4, kind: "not_allowed", status: 401 },
      { expected: 4, kind: "not_allowed", status: 403 },
      { expected: 5, kind: "not_found", status: 404 },
      { expected: 6, kind: "server", status: 500 },
    ];
    for (const { expected, kind, status } of cases) {
      const { transport } = recordingTransport({ error: "no" }, status);
      const result = await runApi(
        ["list", "gadgets"],
        runDeps(testTable, transport),
      );
      expect(result.code).toBe(expected);
      const answer = JSON.parse(result.err ?? "");
      expect(answer.error.kind).toBe(kind);
      expect(answer.error.status).toBe(status);
      expect(answer.error.fields).toBeNull();
      expect(typeof answer.error.message).toBe("string");
    }
  });

  test("maps a transport failure to exit 6", async () => {
    const transport = async (_request: AdminApiRequest): Promise<never> => {
      throw new Error("curl request failed");
    };
    await expectServerFailure(transport);
  });

  /** One refused command: exit 2 with the usage kind, a message that names
   *  the problem, the status null because no server answered, and nothing
   *  sent to the transport. */
  const expectUsageRejection = async (
    args: readonly string[],
    message: string,
  ): Promise<void> => {
    const { requests, transport } = recordingTransport({});
    const result = await runApi(args, runDeps(testTable, transport));
    expect(result.code).toBe(2);
    const error = JSON.parse(result.err ?? "").error;
    expect(error.kind).toBe("usage");
    says(error.message, message);
    expect(error.status).toBeNull();
    expect(requests).toEqual([]);
  };

  /** One refused write: nothing was sent, and the answer names the fields
   *  that failed. */
  const expectRefusedWithFields = async (
    args: string[],
  ): Promise<{ code: number; fields: unknown; message: string }> => {
    const { requests, transport } = recordingTransport({});
    const result = await runApi(args, runDeps(testTable, transport));
    expect(result.code).toBe(3);
    expect(requests).toEqual([]);
    const answer = JSON.parse(result.err ?? "");
    expect(answer.error.kind).toBe("validation");
    return {
      code: result.code,
      fields: answer.error.fields,
      message: answer.error.message,
    };
  };

  /** One server failure: exit 6 with the server kind. Returns the parsed
   *  error for the caller's own assertions. */
  const expectServerFailure = async (
    transport: RunDeps["transport"],
  ): Promise<Record<string, unknown>> => {
    const result = await runApi(
      ["list", "gadgets"],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(6);
    const answer = JSON.parse(result.err ?? "").error;
    expect(answer.kind).toBe("server");
    return answer;
  };

  test("stops a bad body before any request and answers exit 3 with fields", async () => {
    const refused = await expectRefusedWithFields([
      "create",
      "gadgets",
      '{"name":42}',
    ]);
    expect(refused.fields).toEqual([
      { field: "name", message: expect.any(String) },
    ]);
  });

  test("answers exit 3 with fields when a delete carries no confirmation", async () => {
    const refused = await expectRefusedWithFields(["delete", "gadgets", "5"]);
    expect(refused.fields).toEqual([
      { field: "confirm_identifier", message: expect.any(String) },
    ]);
  });

  test("sends a server-validated body as it parsed it", async () => {
    const { requests, transport } = recordingTransport({ gadget: {} });
    const result = await runApi(
      ["update", "gadgets", "5", '{"name":"N","extra":true}'],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(0);
    expect(requests).toEqual([
      {
        body: { extra: true, name: "N" },
        method: "PUT",
        path: "/api/admin/gadgets/5",
      },
    ]);
  });

  test("reads a '-' body from stdin", async () => {
    const { requests, transport } = recordingTransport({ gadget: {} });
    const result = await runApi(
      ["create", "gadgets", "-"],
      runDeps(testTable, transport, { readStdin: async () => '{"name":"N"}' }),
    );
    expect(result.code).toBe(0);
    expect(requests[0]).toEqual({
      body: { name: "N" },
      method: "POST",
      path: "/api/admin/gadgets",
    });
  });

  test("answers exit 3 when the body argument is not JSON", async () => {
    const { requests, transport } = recordingTransport({});
    const result = await runApi(
      ["create", "gadgets", "not json"],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(3);
    expect(requests).toEqual([]);
    says(JSON.parse(result.err ?? "").error.message, "not valid JSON");
  });

  test("reads a '-' body through the default stdin side", async () => {
    const { requests, transport } = recordingTransport({});
    const result = await runApi(
      ["delete", "gadgets", "5", "-"],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(3);
    expect(requests).toEqual([]);
    const answer = JSON.parse(result.err ?? "");
    expect(answer.error.fields).toEqual([
      { field: "confirm_identifier", message: expect.any(String) },
    ]);
  });

  test("answers exit 3 when a checked body is not an object", async () => {
    const refused = await expectRefusedWithFields(["create", "gadgets", "5"]);
    expect(refused.fields).toEqual([
      { field: "", message: expect.any(String) },
    ]);
  });

  test("sends a delete with its confirmation through the typed client", async () => {
    const { requests, transport } = recordingTransport({ status: "ok" });
    const result = await runApi(
      ["delete", "gadgets", "5", '{"confirm_identifier":"Gadget"}'],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(0);
    expect(requests).toEqual([
      {
        body: { confirm_identifier: "Gadget" },
        method: "DELETE",
        path: "/api/admin/gadgets/5",
      },
    ]);
    expect(JSON.parse(result.out ?? "")).toEqual({ status: "ok" });
  });

  test("reads one row through the typed client", async () => {
    const { requests, transport } = recordingTransport({ gadget: { id: 5 } });
    const result = await runApi(
      ["get", "gadgets", "5"],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ method: "GET", path: "/api/admin/gadgets/5" }]);
  });

  test("carries the server's error text when its body is not an error object", async () => {
    const bodies: unknown[] = ["oops", null, { detail: "nope" }, { error: 42 }];
    for (const data of bodies) {
      const { transport } = recordingTransport(data, 400);
      const result = await runApi(
        ["list", "gadgets"],
        runDeps(testTable, transport),
      );
      expect(result.code).toBe(3);
      const answer = JSON.parse(result.err ?? "");
      expect(answer.error.kind).toBe("validation");
      expect(answer.error.status).toBe(400);
      says(answer.error.message, "admin api request failed");
    }
  });

  test("answers the contract's error for a transport that throws a non-error", async () => {
    const transport = async (_request: AdminApiRequest): Promise<never> => {
      throw "not an error object"; // A broken transport may reject with anything.
    };
    const answer = await expectServerFailure(transport);
    expect(answer.message).toBe("not an error object");
  });

  test("keeps the served status when a success reply fails the envelope schema", async () => {
    const answer = await expectServerFailure(
      recordingTransport({}, 200).transport,
    );
    expect(answer.status).toBe(200);
  });

  test("sends a child create through the typed client", async () => {
    const { requests, transport } = recordingTransport({
      gadget: { id: 3, parts: [{ id: 9, label: "L" }] },
    });
    const result = await runApi(
      ["create", "gadgets", "3/parts", '{"label":"L"}'],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(0);
    expect(requests).toEqual([
      {
        body: { label: "L" },
        method: "POST",
        path: "/api/admin/gadgets/3/parts",
      },
    ]);
  });

  test("sends child update and delete with the child id in the path", async () => {
    const update = recordingTransport({
      gadget: { id: 9, parts: [{ id: 9, label: "L2" }] },
    });
    const updateResult = await runApi(
      ["update", "gadgets", "3/parts/9", '{"label":"L2"}'],
      runDeps(testTable, update.transport),
    );
    expect(updateResult.code).toBe(0);
    expect(update.requests).toEqual([
      {
        body: { label: "L2" },
        method: "PUT",
        path: "/api/admin/gadgets/3/parts/9",
      },
    ]);
    const remove = recordingTransport({ status: "ok" });
    const removeResult = await runApi(
      ["delete", "gadgets", "3/parts/9", '{"confirm_identifier":"9"}'],
      runDeps(testTable, remove.transport),
    );
    expect(removeResult.code).toBe(0);
    expect(remove.requests).toEqual([
      {
        body: { confirm_identifier: "9" },
        method: "DELETE",
        path: "/api/admin/gadgets/3/parts/9",
      },
    ]);
  });

  test("rejects a child update without the child id before any request", async () => {
    await expectUsageRejection(
      ["update", "gadgets", "1/parts", '{"label":"changed"}'],
      "needs the child id",
    );
  });

  test("rejects a child delete without the child id before any request", async () => {
    await expectUsageRejection(
      ["delete", "gadgets", "1/parts", '{"confirm_identifier":"1"}'],
      "needs the child id",
    );
  });

  test("rejects an inherited table property as a resource", async () => {
    await expectUsageRejection(
      ["describe", "constructor"],
      "Unknown resource 'constructor'",
    );
    await expectUsageRejection(
      ["list", "constructor"],
      "Unknown resource 'constructor'",
    );
  });

  test("rejects an inherited property as a child key", async () => {
    await expectUsageRejection(
      ["create", "gadgets", "1/constructor", '{"label":"L"}'],
      "has no child 'constructor'",
    );
  });

  test("rejects an inherited property as a custom route", async () => {
    await expectUsageRejection(
      ["toString", "listings", "1"],
      "Unknown command 'toString'",
    );
  });

  test("sends a custom route with the id substituted", async () => {
    const { requests, transport } = recordingTransport({ status: "ok" });
    const result = await runApi(
      ["recalibrate", "gadgets", "7"],
      runDeps(testTable, transport),
    );
    expect(result.code).toBe(0);
    expect(requests).toEqual([
      { method: "POST", path: "/api/admin/gadgets/7/recalibrate" },
    ]);
  });

  test("answers exit 2 for a route the resource does not carry", async () => {
    await expectUsageRejection(
      ["recalibrate", "listings", "7"],
      "is not a route of 'listings'",
    );
  });

  test("answers exit 2 when the command is missing", async () => {
    await expectUsageRejection([], "needs a command");
  });

  test("answers exit 2 when the arguments are too many", async () => {
    await expectUsageRejection(
      ["get", "gadgets", "5", "6"],
      "Too many arguments.",
    );
  });

  test("answers exit 2 with a JSON error when the config is missing", async () => {
    const { transport } = recordingTransport({});
    const result = await runApi(
      ["list", "gadgets"],
      runDeps(testTable, transport, {
        config: async () => {
          throw new CliError(
            "usage",
            "The API host is missing. Set API_HOSTNAME and API_KEY in the environment or the repo .env file.",
          );
        },
      }),
    );
    expect(result.code).toBe(2);
    const answer = JSON.parse(result.err ?? "");
    expect(answer.error.kind).toBe("usage");
    expect(answer.error.status).toBeNull();
    expect(answer.error.fields).toBeNull();
    says(answer.error.message, "API_HOSTNAME");
  });
});
