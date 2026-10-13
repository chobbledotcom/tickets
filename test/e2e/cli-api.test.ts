import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { createTestApiKeyToken } from "#test-utils/session.ts";

// Absolute project root, derived from this file's location rather than the
// process cwd. The suite runs with --parallel, so the cwd is shared mutable
// state: another test file may Deno.chdir() into a temp dir it then deletes.
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const serveTestApi = (): { hostname: string; stop: () => Promise<void> } => {
  let hostname = "";
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      onListen: ({ hostname: host, port }) => {
        hostname = `http://${host}:${port}`;
      },
      port: 0,
    },
    (request) => handleRequest(request),
  );
  if (!hostname) throw new Error("Test API server did not start");
  return { hostname, stop: () => server.shutdown() };
};

const runCliApiRaw = async (
  hostname: string,
  apiKey: string,
  args: string[],
): Promise<Deno.CommandOutput> => {
  const command = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-env",
      "--allow-read",
      "--allow-run",
      "cli/api.ts",
      ...args,
    ],
    // Pin the spawn's cwd to the project root so it never inherits whatever
    // transient directory a parallel test left behind (which would fail with
    // "No such cwd"), and so the relative cli/api.ts path always resolves.
    cwd: projectRoot,
    env: { API_HOSTNAME: hostname, API_KEY: apiKey },
    stderr: "piped",
    stdout: "piped",
  });
  return command.output();
};

const runCliApi = async (
  hostname: string,
  apiKey: string,
  args: string[],
): Promise<unknown> => {
  const output = await runCliApiRaw(hostname, apiKey, args);
  const stdout = decode(output.stdout);
  if (!output.success) {
    throw new Error(decode(output.stderr).trim() || stdout.trim());
  }
  return JSON.parse(stdout);
};

const runCliApiExpectingFailure = async (
  hostname: string,
  apiKey: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const output = await runCliApiRaw(hostname, apiKey, args);
  return {
    code: output.code,
    stderr: decode(output.stderr),
    stdout: decode(output.stdout),
  };
};

/** Run the real entry with no site to talk to: a temp cwd with no .env, and
 *  explicit empty host and key that defeat any inherited values. The entry
 *  and the Deno config go in as absolute paths, because the temp cwd sits
 *  outside the project. */
const runCliApiWithoutConfig = async (
  args: string[],
): Promise<{ code: number; stderr: string; stdout: string }> => {
  const dir = await Deno.makeTempDir();
  try {
    const command = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env",
        "--allow-read",
        "--allow-run",
        `--config=${join(projectRoot, "deno.json")}`,
        join(projectRoot, "cli", "api.ts"),
        ...args,
      ],
      cwd: dir,
      env: { API_HOSTNAME: "", API_KEY: "" },
      stderr: "piped",
      stdout: "piped",
    });
    const output = await command.output();
    return {
      code: output.code,
      stderr: decode(output.stderr),
      stdout: decode(output.stdout),
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
};

describe("CLI API without configuration", () => {
  test("describes the table with no site configured", async () => {
    const { code, stderr, stdout } = await runCliApiWithoutConfig([
      "describe",
      "listings",
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const described = JSON.parse(stdout) as {
      resources: Record<string, unknown>;
    };
    expect(Object.keys(described.resources)).toContain("listings");
  });

  test("reports the missing site as the usage envelope", async () => {
    const { code, stderr, stdout } = await runCliApiWithoutConfig([
      "list",
      "listings",
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    const body = JSON.parse(stderr) as {
      error: { fields: null; kind: string; message: string; status: null };
    };
    expect(body.error).toEqual({
      fields: null,
      kind: "usage",
      message:
        "The API host is missing. Set API_HOSTNAME and API_KEY in the environment or the repo .env file.",
      status: null,
    });
  });

  test("answers a missing command before any config read", async () => {
    const { code, stderr, stdout } = await runCliApiWithoutConfig([]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    const body = JSON.parse(stderr) as {
      error: { kind: string; message: string };
    };
    expect(body.error.kind).toBe("usage");
    expect(body.error.message.startsWith("The CLI needs a command.")).toBe(
      true,
    );
  });
});

describeWithEnv("CLI API e2e", { db: true }, () => {
  describe("list listings", () => {
    test("reads listings from a served site API", async () => {
      const first = await createTestListing({ name: "CLI Matinee" });
      const second = await createTestListing({ name: "CLI Evening" });
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const body = await runCliApi(api.hostname, apiKey, [
          "list",
          "listings",
        ]);

        expect(body).toEqual(
          expect.objectContaining({
            listings: expect.arrayContaining([
              expect.objectContaining({
                id: first.id,
                name: "CLI Matinee",
              }),
              expect.objectContaining({
                id: second.id,
                name: "CLI Evening",
              }),
            ]),
          }),
        );
      } finally {
        await api.stop();
      }
    });
  });

  describe("resource commands", () => {
    test("gets, creates, updates, and deletes listings through the served API", async () => {
      const listing = await createTestListing({ name: "CLI Editable" });
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const fetched = await runCliApi(api.hostname, apiKey, [
          "get",
          "listings",
          String(listing.id),
        ]);
        const created = await runCliApi(api.hostname, apiKey, [
          "create",
          "listings",
          JSON.stringify({ max_attendees: 12, name: "CLI Created" }),
        ]);
        const createdListing = (created as { listing: { id: number } }).listing;
        const updated = await runCliApi(api.hostname, apiKey, [
          "update",
          "listings",
          String(createdListing.id),
          JSON.stringify({ name: "CLI Updated" }),
        ]);
        const deleted = await runCliApi(api.hostname, apiKey, [
          "delete",
          "listings",
          String(createdListing.id),
          JSON.stringify({ confirm_identifier: "CLI Updated" }),
        ]);

        expect(fetched).toEqual(
          expect.objectContaining({
            listing: expect.objectContaining({
              id: listing.id,
              name: "CLI Editable",
            }),
          }),
        );
        expect(created).toEqual(
          expect.objectContaining({
            listing: expect.objectContaining({ name: "CLI Created" }),
          }),
        );
        expect(updated).toEqual(
          expect.objectContaining({
            listing: expect.objectContaining({ name: "CLI Updated" }),
          }),
        );
        expect(deleted).toEqual({ status: "ok" });
      } finally {
        await api.stop();
      }
    });

    test("answers exit 2 with a JSON usage error for an unknown command", async () => {
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(api.hostname, apiKey, [
          "publish",
          "listings",
        ]);

        expect(result.code).toBe(2);
        expect(JSON.parse(result.stderr).error).toEqual({
          fields: null,
          kind: "usage",
          message: expect.stringContaining("Unknown command 'publish'"),
          status: null,
        });
      } finally {
        await api.stop();
      }
    });

    test("answers exit 2 with a JSON usage error when arguments are missing", async () => {
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(
          api.hostname,
          apiKey,
          [],
        );

        expect(result.code).toBe(2);
        expect(JSON.parse(result.stderr).error.kind).toBe("usage");
      } finally {
        await api.stop();
      }
    });

    test("answers exit 3 when a create sends a body the server refuses", async () => {
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(api.hostname, apiKey, [
          "create",
          "listings",
          "{}",
        ]);

        expect(result.code).toBe(3);
        const answer = JSON.parse(result.stderr);
        expect(answer.error.kind).toBe("validation");
        expect(answer.error.status).toBe(400);
      } finally {
        await api.stop();
      }
    });

    test("answers exit 3 when a delete carries no confirmation", async () => {
      const listing = await createTestListing({ name: "CLI Delete Guard" });
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(api.hostname, apiKey, [
          "delete",
          "listings",
          String(listing.id),
        ]);

        expect(result.code).toBe(3);
        expect(JSON.parse(result.stderr).error.kind).toBe("validation");
      } finally {
        await api.stop();
      }
    });

    test("answers exit 5 for an unknown listing", async () => {
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(api.hostname, apiKey, [
          "get",
          "listings",
          "999999",
        ]);

        expect(result.code).toBe(5);
        expect(JSON.parse(result.stderr).error.kind).toBe("not_found");
      } finally {
        await api.stop();
      }
    });
  });

  describe("malformed server replies", () => {
    test("keeps the served status when a 200 reply fails the envelope schema", async () => {
      // The reply is valid JSON that the table's envelope does not describe,
      // so the failure happens after curl: the served status must survive.
      const server = Deno.serve(
        { hostname: "127.0.0.1", port: 0 },
        () =>
          new Response("{}", {
            headers: { "content-type": "application/json" },
          }),
      );
      const { port } = server.addr;
      try {
        const result = await runCliApiExpectingFailure(
          `http://127.0.0.1:${port}`,
          "unused-key",
          ["list", "listings"],
        );

        expect(result.code).toBe(6);
        expect(result.stdout).toBe("");
        const answer = JSON.parse(result.stderr);
        expect(answer.error.kind).toBe("server");
        expect(answer.error.status).toBe(200);
        expect(answer.error.fields).toBeNull();
        expect(answer.error.message).toContain("failed validation");
      } finally {
        await server.shutdown();
      }
    });
  });
});
