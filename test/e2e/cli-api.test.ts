import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  createTestApiKeyToken,
  createTestListing,
  describeWithEnv,
} from "#test-utils";

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
): Promise<{ code: number; stderr: string }> => {
  const output = await runCliApiRaw(hostname, apiKey, args);
  return { code: output.code, stderr: decode(output.stderr) };
};

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

    test("prints usage for an unknown command", async () => {
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(api.hostname, apiKey, [
          "publish",
          "listings",
        ]);

        expect(result.code).toBe(2);
        expect(result.stderr).toContain(
          "Usage: deno task cli:api <list|get|create|update|delete>",
        );
      } finally {
        await api.stop();
      }
    });

    test("prints usage when arguments are missing", async () => {
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(
          api.hostname,
          apiKey,
          [],
        );

        expect(result.code).toBe(2);
        expect(result.stderr).toContain(
          "Usage: deno task cli:api <list|get|create|update|delete>",
        );
      } finally {
        await api.stop();
      }
    });

    test("surfaces API failures from create commands with omitted JSON bodies", async () => {
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(api.hostname, apiKey, [
          "create",
          "listings",
        ]);

        expect(result.code).toBe(1);
      } finally {
        await api.stop();
      }
    });

    test("surfaces API failures from commands with omitted JSON bodies", async () => {
      const listing = await createTestListing({ name: "CLI Delete Guard" });
      const apiKey = await createTestApiKeyToken();
      const api = serveTestApi();

      try {
        const result = await runCliApiExpectingFailure(api.hostname, apiKey, [
          "delete",
          "listings",
          String(listing.id),
        ]);

        expect(result.code).toBe(1);
      } finally {
        await api.stop();
      }
    });
  });
});
