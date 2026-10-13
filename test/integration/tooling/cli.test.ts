import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { loadConfig } from "#cli/config.ts";
import { buildCurlArgs, curlFailureMessage, curlJson, curlTransport } from "#cli/curl.ts";
import { CliError } from "#cli/errors.ts";
import { readStdin, type StdinLike, writeErr, writeOut } from "#cli/io.ts";
import { runApi } from "#cli/run.ts";
import { adminApiRoutes } from "#routes/admin/api.ts";
import { jsonResponse } from "#routes/response.ts";
import {
  ADMIN_API_RESOURCES,
  type AdminApiResource,
} from "#shared/admin-api-resources.ts";
import { runDeps, testTable } from "#test-utils/cli-table.ts";
import { withEnv } from "#test-utils/env.ts";
import { withTempDir } from "#test-utils/files.ts";

describe("CLI config", () => {
  test("loads and normalizes environment config", async () => {
    using _env = withEnv({
      API_HOSTNAME: "tickets.example.com/",
      API_KEY: "env-key",
    });
    await withTempDir((envDir) =>
      expect(loadConfig(envDir)).resolves.toEqual({
        apiHostname: "https://tickets.example.com",
        apiKey: "env-key",
      }),
    );
  });

  test("loads quoted dotenv config while skipping comments and invalid lines", async () => {
    using _env = withEnv({
      API_HOSTNAME: undefined,
      API_KEY: undefined,
    });
    await withTempDir(async (envDir) => {
      await Deno.writeTextFile(
        join(envDir, ".env"),
        [
          "# local CLI config",
          "not valid",
          "API_HOSTNAME='http://localhost:4567/'",
          'API_KEY="dot-key"',
        ].join("\n"),
      );

      await expect(loadConfig(envDir)).resolves.toEqual({
        apiHostname: "http://localhost:4567",
        apiKey: "dot-key",
      });
    });
  });

  test("rejects a missing host instead of prompting", async () => {
    using _env = withEnv({ API_HOSTNAME: undefined, API_KEY: "env-key" });
    const prompt = stub(globalThis, "prompt", () => {
      throw new Error("the CLI must not prompt");
    });
    try {
      await withTempDir((envDir) =>
        expect(loadConfig(envDir)).rejects.toThrow("The API host is missing"),
      );
    } finally {
      prompt.restore();
    }
  });

  test("rejects a missing key instead of prompting", async () => {
    using _env = withEnv({
      API_HOSTNAME: "tickets.example.com",
      API_KEY: undefined,
    });
    const prompt = stub(globalThis, "prompt", () => {
      throw new Error("the CLI must not prompt");
    });
    try {
      await withTempDir((envDir) =>
        expect(loadConfig(envDir)).rejects.toThrow("The API key is missing"),
      );
    } finally {
      prompt.restore();
    }
  });

  test("surfaces dotenv read errors that are not missing files", async () => {
    using _env = withEnv({
      API_HOSTNAME: "tickets.example.com",
      API_KEY: "env-key",
    });
    await withTempDir(async (envDir) => {
      await Deno.mkdir(join(envDir, ".env"));
      await expect(loadConfig(envDir)).rejects.toThrow();
    });
  });
});

describe("CLI curl", () => {
  test("builds GET args without a JSON body", () => {
    expect(
      buildCurlArgs(
        { apiHostname: "https://tickets.example.com", apiKey: "key" },
        { method: "GET", path: "api/admin/listings" },
      ),
    ).toEqual([
      "--silent",
      "--show-error",
      "--request",
      "GET",
      "--header",
      "Authorization: Bearer key",
      "--header",
      "Accept: application/json",
      "--write-out",
      "\n%{http_code}",
      "https://tickets.example.com/api/admin/listings",
    ]);
  });

  test("builds JSON body args for mutating requests", () => {
    expect(
      buildCurlArgs(
        { apiHostname: "http://localhost:3000", apiKey: "secret" },
        { body: { name: "Demo" }, method: "POST", path: "/api/admin/listings" },
      ),
    ).toContain(JSON.stringify({ name: "Demo" }));
  });

  test("throws the curl failure output", async () => {
    await expect(
      curlJson(
        { apiHostname: "http://127.0.0.1:9", apiKey: "key" },
        { method: "GET", path: "/api/admin/listings" },
      ),
    ).rejects.toThrow();
  });

  test("answers a served JSON body with its parsed data and status", async () => {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, () =>
      jsonResponse({ ok: true }),
    );
    const { port } = server.addr;
    try {
      await expect(
        curlJson(
          { apiHostname: `http://127.0.0.1:${port}`, apiKey: "key" },
          { method: "GET", path: "/api/admin/listings" },
        ),
      ).resolves.toEqual({ data: { ok: true }, status: 200 });
    } finally {
      await server.shutdown();
    }
  });

  test("binds one config into every request the transport sends", async () => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      (request) => jsonResponse({ path: new URL(request.url).pathname }),
    );
    const { port } = server.addr;
    try {
      const transport = curlTransport({
        apiHostname: `http://127.0.0.1:${port}`,
        apiKey: "key",
      });
      await expect(
        transport({ method: "GET", path: "/api/admin/listings" }),
      ).resolves.toEqual({ data: { path: "/api/admin/listings" }, status: 200 });
    } finally {
      await server.shutdown();
    }
  });

  /** One caught curlJson answer against the port: the tests assert the
   *  thrown shape, so the rejection becomes a value. */
  const curlJsonFailure = (port: number): Promise<unknown> =>
    curlJson(
      { apiHostname: `http://127.0.0.1:${port}`, apiKey: "key" },
      { method: "GET", path: "/api/admin/listings" },
    ).catch((error: unknown) => error);

  test("keeps the status on the error when a success reply is not JSON", async () => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      () => new Response("<html>sign in</html>"),
    );
    const { port } = server.addr;
    try {
      const failure = await curlJsonFailure(port);
      expect(failure).toBeInstanceOf(CliError);
      expect((failure as CliError).message).toContain("not JSON");
      expect((failure as CliError).status).toBe(200);
    } finally {
      await server.shutdown();
    }
  });

  test("prefers stderr for curl failure messages", () => {
    expect(curlFailureMessage(" stderr failure \n", "stdout failure")).toBe(
      "stderr failure",
    );
  });

  test("falls back from stderr to stdout for curl failure messages", () => {
    expect(curlFailureMessage("", " stdout failure \n")).toBe("stdout failure");
  });

  test("uses a generic curl failure message when output is empty", () => {
    expect(curlFailureMessage("", "")).toBe("curl request failed");
  });

  /** One CLI run over the real curl transport against a local server that
   *  answers every request with `respond`. Returns the agent-facing error
   *  the run printed. */
  const runAgainstServer = async (
    respond: () => Response,
  ): Promise<{ kind: string; message: string; status: unknown }> => {
    const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, respond);
    const { port } = server.addr;
    try {
      const config = { apiHostname: `http://127.0.0.1:${port}`, apiKey: "key" };
      const result = await runApi(
        ["list", "gadgets"],
        runDeps(testTable, (options) => curlJson(config, options)),
      );
      return JSON.parse(result.err ?? "").error;
    } finally {
      await server.shutdown();
    }
  };

  test("reports the HTTP status for an HTML reply", async () => {
    const error = await runAgainstServer(
      () => new Response("<html>bad gateway</html>", { status: 502 }),
    );
    expect(error.kind).toBe("server");
    expect(error.status).toBe(502);
    expect(error.message).toContain("admin api request failed");
  });

  test("maps an HTML 401 reply to the not-allowed kind", async () => {
    const error = await runAgainstServer(
      () => new Response("<html>sign in</html>", { status: 401 }),
    );
    expect(error.kind).toBe("not_allowed");
    expect(error.status).toBe(401);
  });

  test("reports the HTTP status for an empty reply", async () => {
    const error = await runAgainstServer(
      () => new Response(null, { status: 304 }),
    );
    expect(error.kind).toBe("server");
    expect(error.status).toBe(304);
  });

  test("answers a server-kind error for a curl transfer failure", async () => {
    const server = Deno.serve(
      { hostname: "127.0.0.1", port: 0 },
      () => new Response("abandoned"),
    );
    const { port } = server.addr;
    await server.shutdown();
    const failure = await curlJsonFailure(port);
    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).kind).toBe("server");
    expect((failure as CliError).status).toBeUndefined();
  });
});

describe("CLI table-vs-server", () => {
  test("exposes exactly the routes the admin API serves", () => {
    // Every route key the server registers must be one the table can name:
    // the resource paths, the child paths under them, and the custom routes.
    // Neither side can silently drift.
    const entries: readonly [string, AdminApiResource][] =
      Object.entries(ADMIN_API_RESOURCES);
    const declared = entries.flatMap(([, entry]) => {
      const root = `/api/admin/${entry.path}`;
      const idParam = `:${entry.label.toLowerCase()}Id`;
      const children = Object.entries(entry.children ?? {}).flatMap(
        ([, child]) => [
          `POST ${root}/${idParam}/${child.path}`,
          `PUT ${root}/${idParam}/${child.path}/:${child.idParam}`,
          `DELETE ${root}/${idParam}/${child.path}/:${child.idParam}`,
        ],
      );
      const custom = Object.entries(entry.custom ?? {}).map(
        ([, route]) => `${route.method} ${root}/${route.subpath}`,
      );
      return [
        `GET ${root}`,
        `GET ${root}/${idParam}`,
        `POST ${root}`,
        `PUT ${root}/${idParam}`,
        `DELETE ${root}/${idParam}`,
        ...children,
        ...custom,
      ];
    });
    // A custom route may occupy the standard delete's key, and the server's
    // route map holds each key once.
    expect([...new Set(declared)].sort()).toEqual(
      Object.keys(adminApiRoutes).sort(),
    );
  });
});

describe("CLI io", () => {
  const captureStdio = async (
    act: () => Promise<void>,
  ): Promise<{ out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const recorder = (sink: string[]) => (bytes: Uint8Array) => {
      sink.push(new TextDecoder().decode(bytes));
      return Promise.resolve(bytes.length);
    };
    const outStub = stub(Deno.stdout, "write", recorder(out));
    const errStub = stub(Deno.stderr, "write", recorder(err));
    try {
      await act();
    } finally {
      outStub.restore();
      errStub.restore();
    }
    return { err, out };
  };

  test("writeOut writes encoded text to stdout", async () => {
    const { out, err } = await captureStdio(() => writeOut("hello"));
    expect(out).toEqual(["hello"]);
    expect(err).toEqual([]);
  });

  test("writeErr writes encoded text to stderr", async () => {
    const { out, err } = await captureStdio(() => writeErr("nope\n"));
    expect(err).toEqual(["nope\n"]);
    expect(out).toEqual([]);
  });

  describe("readStdin", () => {
    /** One stdin side that answers with the given chunks, then ends. */
    const piped = (
      chunks: readonly string[],
    ): { input: StdinLike; reads: number } => {
      const encoder = new TextEncoder();
      const payloads = chunks.map((text) => encoder.encode(text));
      let reads = 0;
      return {
        input: {
          isTerminal: () => false,
          read: async (buffer: Uint8Array) => {
            const payload = payloads[reads];
            reads += 1;
            if (payload === undefined) return null;
            buffer.set(payload.subarray(0, buffer.length));
            return Math.min(payload.length, buffer.length);
          },
        },
        reads,
      };
    };

    test("reads every chunk and decodes the text", async () => {
      const { input } = piped(['{"name":', '"Demo"}']);
      await expect(readStdin(input)).resolves.toBe('{"name":"Demo"}');
    });

    test("answers an empty string when stdin closes with nothing", async () => {
      const { input } = piped([]);
      await expect(readStdin(input)).resolves.toBe("");
    });

    test("refuses a terminal stdin with a usage error", async () => {
      const failure = await readStdin({
        isTerminal: () => true,
        read: async () => null,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(CliError);
      expect((failure as CliError).kind).toBe("usage");
      expect((failure as Error).message).toContain("stdin is a terminal");
    });
  });
});
