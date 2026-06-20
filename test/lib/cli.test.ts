import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { setTestEnv } from "#test-utils";
import { loadConfig } from "../../cli/config.ts";
import { buildCurlArgs, curlFailureMessage, curlJson } from "../../cli/curl.ts";
import { parseResource, resourcePath } from "../../cli/resources.ts";

const withTempCwd = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = Deno.cwd();
  const dir = await Deno.makeTempDir();
  try {
    Deno.chdir(dir);
    return await fn();
  } finally {
    Deno.chdir(original);
    await Deno.remove(dir, { recursive: true });
  }
};

describe("CLI config", () => {
  test("loads and normalizes environment config", async () => {
    const restore = setTestEnv({
      API_HOSTNAME: "tickets.example.com/",
      API_KEY: "env-key",
    });
    try {
      await withTempCwd(async () => {
        await expect(loadConfig()).resolves.toEqual({
          apiHostname: "https://tickets.example.com",
          apiKey: "env-key",
        });
      });
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
      await withTempCwd(async () => {
        await Deno.writeTextFile(
          ".env",
          [
            "# local CLI config",
            "not valid",
            "API_HOSTNAME='http://localhost:4567/'",
            'API_KEY="dot-key"',
          ].join("\n"),
        );

        await expect(loadConfig()).resolves.toEqual({
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
      await withTempCwd(async () => {
        await expect(loadConfig()).resolves.toEqual({
          apiHostname: "https://prompt.test",
          apiKey: "prompt-key",
        });
      });
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
      await withTempCwd(async () => {
        await expect(loadConfig()).rejects.toThrow("API host is required");
      });
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
      await withTempCwd(async () => {
        await expect(loadConfig()).rejects.toThrow("API host is required");
      });
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
      await withTempCwd(async () => {
        await expect(loadConfig()).resolves.toEqual({
          apiHostname: "",
          apiKey: "env-key",
        });
      });
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
      await withTempCwd(async () => {
        await Deno.mkdir(".env");
        await expect(loadConfig()).rejects.toThrow();
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
    expect(parseResource("attendees")).toBe("attendees");
    expect(() => parseResource("orders")).toThrow(
      "Unknown resource: orders. Expected listings, attendees, modifiers",
    );
  });
});
