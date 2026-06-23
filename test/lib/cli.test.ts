import { join } from "node:path";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { adminApiRoutes } from "#routes/admin/api.ts";
import { setTestEnv } from "#test-utils";
import { buildRequest, parseBody } from "../../cli/api-request.ts";
import { loadConfig } from "../../cli/config.ts";
import { buildCurlArgs, curlFailureMessage, curlJson } from "../../cli/curl.ts";
import { clearScreen, writeErr, writeOut } from "../../cli/io.ts";
import { parseResource, resourcePath, resources } from "../../cli/resources.ts";

// Run `fn` against a throwaway directory it can populate with a `.env`. The
// directory is passed in explicitly rather than via Deno.chdir, because the cwd
// is process-global: changing it here would race with parallel test files that
// spawn subprocesses inheriting that cwd (see test/e2e/cli-api.test.ts).
const withTempEnvDir = async <T>(
  fn: (envDir: string) => Promise<T>,
): Promise<T> => {
  const envDir = await Deno.makeTempDir();
  try {
    return await fn(envDir);
  } finally {
    await Deno.remove(envDir, { recursive: true });
  }
};

describe("CLI config", () => {
  test("loads and normalizes environment config", async () => {
    const restore = setTestEnv({
      API_HOSTNAME: "tickets.example.com/",
      API_KEY: "env-key",
    });
    try {
      await withTempEnvDir((envDir) =>
        expect(loadConfig(envDir)).resolves.toEqual({
          apiHostname: "https://tickets.example.com",
          apiKey: "env-key",
        }),
      );
    } finally {
      restore();
    }
  });

  test("loads quoted dotenv config while skipping comments and invalid lines", async () => {
    const restore = setTestEnv({
      API_HOSTNAME: undefined,
      API_KEY: undefined,
    });
    try {
      await withTempEnvDir(async (envDir) => {
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
    } finally {
      restore();
    }
  });

  test("prompts for missing config", async () => {
    const restore = setTestEnv({
      API_HOSTNAME: undefined,
      API_KEY: undefined,
    });
    const prompt = stub(globalThis, "prompt", (label?: string) =>
      label === "API host" ? "prompt.test" : "prompt-key",
    );
    try {
      await withTempEnvDir((envDir) =>
        expect(loadConfig(envDir)).resolves.toEqual({
          apiHostname: "https://prompt.test",
          apiKey: "prompt-key",
        }),
      );
    } finally {
      prompt.restore();
      restore();
    }
  });

  test("rejects empty prompted config", async () => {
    const restore = setTestEnv({
      API_HOSTNAME: undefined,
      API_KEY: undefined,
    });
    const prompt = stub(globalThis, "prompt", () => "");
    try {
      await withTempEnvDir((envDir) =>
        expect(loadConfig(envDir)).rejects.toThrow("API host is required"),
      );
    } finally {
      prompt.restore();
      restore();
    }
  });

  test("rejects missing prompted config", async () => {
    const restore = setTestEnv({
      API_HOSTNAME: undefined,
      API_KEY: undefined,
    });
    const prompt = stub(globalThis, "prompt", () => null);
    try {
      await withTempEnvDir((envDir) =>
        expect(loadConfig(envDir)).rejects.toThrow("API host is required"),
      );
    } finally {
      prompt.restore();
      restore();
    }
  });

  test("preserves an explicitly blank environment host", async () => {
    const restore = setTestEnv({
      API_HOSTNAME: "   ",
      API_KEY: "env-key",
    });
    try {
      await withTempEnvDir((envDir) =>
        expect(loadConfig(envDir)).resolves.toEqual({
          apiHostname: "",
          apiKey: "env-key",
        }),
      );
    } finally {
      restore();
    }
  });

  test("surfaces dotenv read errors that are not missing files", async () => {
    const restore = setTestEnv({
      API_HOSTNAME: "tickets.example.com",
      API_KEY: "env-key",
    });
    try {
      await withTempEnvDir(async (envDir) => {
        await Deno.mkdir(join(envDir, ".env"));
        await expect(loadConfig(envDir)).rejects.toThrow();
      });
    } finally {
      restore();
    }
  });
});

describe("CLI curl", () => {
  test("builds GET args without a JSON body", () => {
    expect(
      buildCurlArgs(
        { apiHostname: "https://tickets.example.com", apiKey: "key" },
        { path: "api/admin/listings" },
      ),
    ).toEqual([
      "--silent",
      "--show-error",
      "--fail-with-body",
      "--request",
      "GET",
      "--header",
      "Authorization: Bearer key",
      "--header",
      "Accept: application/json",
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
        { path: "/api/admin/listings" },
      ),
    ).rejects.toThrow();
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
});

describe("CLI resources", () => {
  test("builds collection and entity paths", () => {
    expect(resourcePath("listings")).toBe("/api/admin/listings");
    expect(resourcePath("listings", "123")).toBe("/api/admin/listings/123");
  });

  test("parses known resources and rejects unknown resources", () => {
    expect(parseResource("holidays")).toBe("holidays");
    expect(() => parseResource("orders")).toThrow(
      "Unknown resource: orders. Expected listings, groups, holidays",
    );
  });

  test("exposes exactly the resources the admin API serves", () => {
    // Derive the resource segment from every registered admin API route key
    // (e.g. "POST /api/admin/groups/:groupId" → "groups"). The CLI's resource
    // list must match this set exactly, so neither side can silently drift.
    const served = [
      ...new Set(
        Object.keys(adminApiRoutes).map(
          (route) => route.match(/\/api\/admin\/([a-z]+)/)?.[1] ?? "",
        ),
      ),
    ].sort();
    expect([...resources].sort()).toEqual(served);
  });
});

describe("CLI api-request", () => {
  test("parseBody returns undefined when no JSON argument is given", () => {
    expect(parseBody(undefined)).toBeUndefined();
    expect(parseBody("")).toBeUndefined();
  });

  test("parseBody parses a JSON string into a value", () => {
    expect(parseBody('{"name":"Demo"}')).toEqual({ name: "Demo" });
  });

  test("builds a bodyless list request", () => {
    expect(buildRequest("list", "listings")).toEqual({
      path: "/api/admin/listings",
    });
  });

  test("builds a get request addressing a single entity", () => {
    expect(buildRequest("get", "listings", "5")).toEqual({
      path: "/api/admin/listings/5",
    });
  });

  test("builds a create request with a parsed JSON body", () => {
    expect(buildRequest("create", "listings", '{"name":"Demo"}')).toEqual({
      body: { name: "Demo" },
      method: "POST",
      path: "/api/admin/listings",
    });
  });

  test("builds an update request from an id and JSON body", () => {
    expect(buildRequest("update", "groups", "7", '{"name":"G"}')).toEqual({
      body: { name: "G" },
      method: "PUT",
      path: "/api/admin/groups/7",
    });
  });

  test("builds a delete request that defaults to no body", () => {
    expect(buildRequest("delete", "holidays", "9")).toEqual({
      body: undefined,
      method: "DELETE",
      path: "/api/admin/holidays/9",
    });
  });

  test("returns null for an unrecognised command", () => {
    expect(buildRequest("publish", "listings")).toBeNull();
  });
});

describe("CLI io", () => {
  const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

  // Stub both std streams while running `act`, returning whatever each received.
  // A single curried recorder keeps the two stubs identical without repetition.
  const captureStdio = async (
    act: () => Promise<void>,
  ): Promise<{ out: string[]; err: string[] }> => {
    const out: string[] = [];
    const err: string[] = [];
    const recorder = (sink: string[]) => (bytes: Uint8Array) => {
      sink.push(decode(bytes));
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

  test("clearScreen writes the ANSI clear-and-home sequence to stdout", async () => {
    const { out } = await captureStdio(() => clearScreen());
    expect(out).toEqual(["\x1b[2J\x1b[H"]);
  });
});
