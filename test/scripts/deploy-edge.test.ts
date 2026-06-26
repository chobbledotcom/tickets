import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  BUNDLE_PATH,
  BUNNY_API_BASE,
  type DeployEdgeDeps,
  deployScriptCode,
  type FetchText,
  type FetchTextResult,
  formatBunnyError,
  getAccessKey,
  parseScriptIdArg,
  publishScript,
  runDeployEdge,
  USAGE,
  uploadScriptCode,
} from "../../scripts/deploy-edge-lib.ts";

interface FetchCall {
  init: RequestInit;
  url: string;
}

const envReader =
  (vars: Record<string, string | undefined>) =>
  (key: string): string | undefined =>
    vars[key];

const fetchRecorder = (
  responses: FetchTextResult[],
): { calls: FetchCall[]; fetchText: FetchText } => {
  const calls: FetchCall[] = [];
  const fetchText: FetchText = (url, init) => {
    calls.push({ init, url });
    return Promise.resolve(
      responses[calls.length - 1] ?? { ok: true, status: 200, text: "{}" },
    );
  };
  return { calls, fetchText };
};

const response = (
  ok: boolean,
  status: number,
  text: string,
): FetchTextResult => ({ ok, status, text });

const headersFrom = (init: RequestInit): Record<string, string> =>
  init.headers as Record<string, string>;

const bodyFrom = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(init.body as string);

const deployDeps = (
  overrides: Partial<DeployEdgeDeps> = {},
): { deps: DeployEdgeDeps; stderr: string[]; stdout: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const recorder = fetchRecorder([
    response(true, 200, "{}"),
    response(true, 200, "{}"),
  ]);

  return {
    deps: {
      args: ["42"],
      bundlePath: "/repo/bunny-script.ts",
      cwd: "/repo",
      fetchText: recorder.fetchText,
      getEnv: envReader({ BUNNY_ACCESS_KEY: "access-key" }),
      readTextFile: () => Promise.resolve("console.log(1)"),
      runBuildEdge: () => Promise.resolve({ code: 0, success: true }),
      stderr: (line) => stderr.push(line),
      stdout: (line) => stdout.push(line),
      ...overrides,
    },
    stderr,
    stdout,
  };
};

const expectDeployFailsBeforeBuild = async (
  overrides: Partial<DeployEdgeDeps>,
): Promise<string[]> => {
  let buildCalled = false;
  const { deps, stderr } = deployDeps({
    ...overrides,
    runBuildEdge: () => {
      buildCalled = true;
      return Promise.resolve({ code: 0, success: true });
    },
  });
  await expect(runDeployEdge(deps)).resolves.toBe(1);
  expect(buildCalled).toBe(false);
  return stderr;
};

describe("deploy-edge argument parsing", () => {
  test("accepts one script ID and trims surrounding whitespace", () => {
    expect(parseScriptIdArg([" 12345 "])).toEqual({
      ok: true,
      scriptId: "12345",
    });
  });

  test("rejects missing, blank, or extra script IDs", () => {
    expect(parseScriptIdArg([])).toEqual({ error: USAGE, ok: false });
    expect(parseScriptIdArg([" "])).toEqual({ error: USAGE, ok: false });
    expect(parseScriptIdArg(["1", "2"])).toEqual({
      error: USAGE,
      ok: false,
    });
  });
});

describe("deploy-edge access key lookup", () => {
  test("prefers BUNNY_ACCESS_KEY from .env", () => {
    expect(
      getAccessKey(
        envReader({ BUNNY_ACCESS_KEY: " access ", BUNNY_API_KEY: "api" }),
      ),
    ).toBe("access");
  });

  test("falls back to BUNNY_API_KEY for existing local env files", () => {
    expect(getAccessKey(envReader({ BUNNY_API_KEY: " api " }))).toBe("api");
  });

  test("ignores blank keys", () => {
    expect(getAccessKey(envReader({ BUNNY_ACCESS_KEY: " " }))).toBeUndefined();
  });
});

describe("deploy-edge Bunny API requests", () => {
  test("formats JSON, raw, and empty Bunny API errors", () => {
    expect(
      formatBunnyError(
        "Upload",
        response(false, 400, JSON.stringify({ Message: "Bad request" })),
      ),
    ).toBe("Upload failed (400): Bad request");
    expect(
      formatBunnyError("Upload", response(false, 500, "Server Error")),
    ).toBe("Upload failed (500): Server Error");
    expect(formatBunnyError("Upload", response(false, 502, ""))).toBe(
      "Upload failed (502): empty response",
    );
    expect(
      formatBunnyError("Upload", response(false, 422, '{"Message":" "}')),
    ).toBe('Upload failed (422): {"Message":" "}');
  });

  test("uploads code using the workflow Bunny endpoint", async () => {
    const recorder = fetchRecorder([response(true, 200, "{}")]);

    const result = await uploadScriptCode(
      "abc/123",
      "console.log(1)",
      "key",
      recorder.fetchText,
    );

    expect(result).toEqual({ ok: true });
    expect(recorder.calls[0]!.url).toBe(
      `${BUNNY_API_BASE}/compute/script/abc%2F123/code`,
    );
    expect(recorder.calls[0]!.init.method).toBe("POST");
    expect(headersFrom(recorder.calls[0]!.init).AccessKey).toBe("key");
    expect(headersFrom(recorder.calls[0]!.init)["Content-Type"]).toBe(
      "application/json",
    );
    expect(bodyFrom(recorder.calls[0]!.init)).toEqual({
      Code: "console.log(1)",
    });
  });

  test("publishes code using an empty JSON body", async () => {
    const recorder = fetchRecorder([response(true, 200, "{}")]);

    const result = await publishScript("123", "key", recorder.fetchText);

    expect(result).toEqual({ ok: true });
    expect(recorder.calls[0]!.url).toBe(
      `${BUNNY_API_BASE}/compute/script/123/publish`,
    );
    expect(bodyFrom(recorder.calls[0]!.init)).toEqual({});
  });

  test("uploads then publishes a script", async () => {
    const recorder = fetchRecorder([
      response(true, 200, "{}"),
      response(true, 200, "{}"),
    ]);

    const result = await deployScriptCode(
      "123",
      "code",
      "key",
      recorder.fetchText,
    );

    expect(result).toEqual({ ok: true });
    expect(recorder.calls.map((call) => call.url)).toEqual([
      `${BUNNY_API_BASE}/compute/script/123/code`,
      `${BUNNY_API_BASE}/compute/script/123/publish`,
    ]);
  });

  test("stops before publishing when upload fails", async () => {
    const recorder = fetchRecorder([response(false, 500, "Nope")]);

    const result = await deployScriptCode(
      "123",
      "code",
      "key",
      recorder.fetchText,
    );

    expect(result).toEqual({
      error: "Upload script code failed (500): Nope",
      ok: false,
    });
    expect(recorder.calls).toHaveLength(1);
  });

  test("returns publish failures after a successful upload", async () => {
    const recorder = fetchRecorder([
      response(true, 200, "{}"),
      response(false, 503, "Unavailable"),
    ]);

    const result = await deployScriptCode(
      "123",
      "code",
      "key",
      recorder.fetchText,
    );

    expect(result).toEqual({
      error: "Publish script failed (503): Unavailable",
      ok: false,
    });
    expect(recorder.calls).toHaveLength(2);
  });
});

describe("runDeployEdge", () => {
  test("builds, reads, uploads, and publishes the bundle", async () => {
    const recorder = fetchRecorder([
      response(true, 200, "{}"),
      response(true, 200, "{}"),
    ]);
    const { deps, stderr, stdout } = deployDeps({
      fetchText: recorder.fetchText,
    });

    await expect(runDeployEdge(deps)).resolves.toBe(0);

    expect(stderr).toEqual([]);
    expect(stdout).toEqual([
      "Building edge bundle...",
      `Uploading ${BUNDLE_PATH} to Bunny script 42...`,
      "Published Bunny script 42.",
    ]);
    expect(recorder.calls).toHaveLength(2);
  });

  test("returns usage errors before building", async () => {
    const stderr = await expectDeployFailsBeforeBuild({ args: [] });
    expect(stderr).toEqual([USAGE]);
  });

  test("requires a Bunny access key before building", async () => {
    const stderr = await expectDeployFailsBeforeBuild({
      getEnv: envReader({}),
    });
    expect(stderr).toEqual([
      "BUNNY_ACCESS_KEY is required in .env (BUNNY_API_KEY also works).",
    ]);
  });

  test("stops when the edge build fails", async () => {
    let readCalled = false;
    const { deps, stderr } = deployDeps({
      readTextFile: () => {
        readCalled = true;
        return Promise.resolve("code");
      },
      runBuildEdge: () => Promise.resolve({ code: 3, success: false }),
    });

    await expect(runDeployEdge(deps)).resolves.toBe(1);

    expect(stderr).toEqual(["build:edge failed with exit code 3"]);
    expect(readCalled).toBe(false);
  });

  test("reports a missing bundle", async () => {
    let fetchCalled = false;
    const { deps, stderr } = deployDeps({
      fetchText: () => {
        fetchCalled = true;
        return Promise.resolve(response(true, 200, "{}"));
      },
      readTextFile: () => Promise.reject(new Error("missing")),
    });

    await expect(runDeployEdge(deps)).resolves.toBe(1);

    expect(stderr[0]).toContain("Failed to read /repo/bunny-script.ts");
    expect(stderr[0]).toContain("Error: missing");
    expect(fetchCalled).toBe(false);
  });

  test("reports deploy failures", async () => {
    const recorder = fetchRecorder([response(false, 401, "Unauthorized")]);
    const { deps, stderr } = deployDeps({
      fetchText: recorder.fetchText,
    });

    await expect(runDeployEdge(deps)).resolves.toBe(1);

    expect(stderr).toEqual(["Upload script code failed (401): Unauthorized"]);
    expect(recorder.calls).toHaveLength(1);
  });
});
