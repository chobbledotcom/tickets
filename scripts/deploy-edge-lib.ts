import { mapNotNullish } from "#fp";
import type { ScriptIo } from "#scripts/script-runner.ts";
import type { FetchText, FetchTextResult } from "./fetch-text.ts";

export type { FetchText, FetchTextResult } from "./fetch-text.ts";

export const BUNNY_API_BASE = "https://api.bunny.net";
export const BUNDLE_PATH = "bunny-script.ts";
export const USAGE = "Usage: deno task deploy:edge <script-id>";
export const DEPLOY_BUILT_USAGE =
  "Usage: deno run scripts/deploy-built-edge.ts <script-id> [file]";
export const ACCESS_KEY_ERROR =
  "BUNNY_ACCESS_KEY is required (BUNNY_API_KEY also works).";

const ACCESS_KEY_ENV_KEYS = ["BUNNY_ACCESS_KEY", "BUNNY_API_KEY"] as const;

export type BunnyDeployResult = { ok: true } | { error: string; ok: false };

/** Shared shape of the script-code operations (upload, deploy). */
type ScriptCodeFn = (
  scriptId: string,
  code: string,
  accessKey: string,
  fetchText: FetchText,
) => Promise<BunnyDeployResult>;

export interface BuildResult {
  code: number;
  success: boolean;
}

export interface DeployEdgeDeps extends ScriptIo {
  bundlePath: string;
  cwd: string;
  fetchText: FetchText;
  readTextFile: (path: string) => Promise<string>;
  runBuildEdge: (cwd: string) => Promise<BuildResult>;
}

export interface DeployBuiltEdgeDeps extends ScriptIo {
  fetchText: FetchText;
  readTextFile: (path: string) => Promise<string>;
}

export interface DeployBuiltArgs {
  bundlePath: string;
  scriptId: string;
}

type ParsedScriptId =
  | { ok: true; scriptId: string }
  | {
      error: string;
      ok: false;
    };

const parseScriptId = (
  value: string | undefined,
  usage: string,
): ParsedScriptId => {
  const scriptId = value?.trim();
  return scriptId ? { ok: true, scriptId } : { error: usage, ok: false };
};

export const parseScriptIdArg = (
  args: string[],
): { ok: true; scriptId: string } | { error: string; ok: false } => {
  if (args.length !== 1) {
    return { error: USAGE, ok: false };
  }

  return parseScriptId(args[0], USAGE);
};

export const parseDeployBuiltArgs = (
  args: string[],
): ({ ok: true } & DeployBuiltArgs) | { error: string; ok: false } => {
  if (args.length < 1 || args.length > 2) {
    return { error: DEPLOY_BUILT_USAGE, ok: false };
  }

  const scriptId = parseScriptId(args[0], DEPLOY_BUILT_USAGE);
  if (!scriptId.ok) return scriptId;

  const fileArg = args[1];
  const bundlePath = fileArg === undefined ? BUNDLE_PATH : fileArg.trim();
  return bundlePath
    ? { bundlePath, ok: true, scriptId: scriptId.scriptId }
    : { error: DEPLOY_BUILT_USAGE, ok: false };
};

export const getAccessKey = (
  getEnv: (key: string) => string | undefined,
): string | undefined =>
  mapNotNullish<(typeof ACCESS_KEY_ENV_KEYS)[number], string>((key) => {
    const value = getEnv(key)?.trim();
    return value ? value : undefined;
  })([...ACCESS_KEY_ENV_KEYS]).at(0);

const parseBunnyMessage = (text: string): string => {
  const fallback = text.trim() || "empty response";
  try {
    const json = JSON.parse(text) as { Message?: unknown };
    if (typeof json.Message === "string" && json.Message.trim()) {
      return json.Message.trim();
    }
  } catch {
    /* use raw response text */
  }
  return fallback;
};

export const formatBunnyError = (
  label: string,
  response: FetchTextResult,
): string =>
  `${label} failed (${response.status}): ${parseBunnyMessage(response.text)}`;

const postScriptAction = async (
  scriptId: string,
  action: "code" | "publish",
  body: Record<string, unknown>,
  accessKey: string,
  label: string,
  fetchText: FetchText,
): Promise<BunnyDeployResult> => {
  const response = await fetchText(
    `${BUNNY_API_BASE}/compute/script/${encodeURIComponent(scriptId)}/${action}`,
    {
      body: JSON.stringify(body),
      headers: {
        AccessKey: accessKey,
        "Content-Type": "application/json",
      },
      method: "POST",
    },
  );

  return response.ok
    ? { ok: true }
    : {
        error: formatBunnyError(label, response),
        ok: false,
      };
};

export const uploadScriptCode: ScriptCodeFn = (
  scriptId,
  code,
  accessKey,
  fetchText,
) =>
  postScriptAction(
    scriptId,
    "code",
    { Code: code },
    accessKey,
    "Upload script code",
    fetchText,
  );

export const publishScript = (
  scriptId: string,
  accessKey: string,
  fetchText: FetchText,
): Promise<BunnyDeployResult> =>
  postScriptAction(
    scriptId,
    "publish",
    {},
    accessKey,
    "Publish script",
    fetchText,
  );

export const deployScriptCode: ScriptCodeFn = async (
  scriptId,
  code,
  accessKey,
  fetchText,
) => {
  const upload = await uploadScriptCode(scriptId, code, accessKey, fetchText);
  if (!upload.ok) return upload;
  return publishScript(scriptId, accessKey, fetchText);
};

interface DeployBuiltBundleDeps extends Pick<ScriptIo, "stderr" | "stdout"> {
  accessKey: string;
  bundlePath: string;
  fetchText: FetchText;
  labelPath: string;
  readTextFile: (path: string) => Promise<string>;
  scriptId: string;
}

const deployBuiltBundle = async (
  deps: DeployBuiltBundleDeps,
): Promise<number> => {
  let code: string;
  try {
    code = await deps.readTextFile(deps.bundlePath);
  } catch (error) {
    deps.stderr(`Failed to read ${deps.bundlePath}: ${String(error)}`);
    return 1;
  }

  deps.stdout(
    `Uploading ${deps.labelPath} to Bunny script ${deps.scriptId}...`,
  );
  const deploy = await deployScriptCode(
    deps.scriptId,
    code,
    deps.accessKey,
    deps.fetchText,
  );
  if (!deploy.ok) {
    deps.stderr(deploy.error);
    return 1;
  }

  deps.stdout(`Published Bunny script ${deps.scriptId}.`);
  return 0;
};

const withAccessKey = async (
  deps: Pick<ScriptIo, "getEnv" | "stderr">,
  run: (accessKey: string) => Promise<number>,
): Promise<number> => {
  const accessKey = getAccessKey(deps.getEnv);
  if (!accessKey) {
    deps.stderr(ACCESS_KEY_ERROR);
    return 1;
  }

  return run(accessKey);
};

export const runDeployBuiltEdge = async (
  deps: DeployBuiltEdgeDeps,
): Promise<number> => {
  const args = parseDeployBuiltArgs(deps.args);
  if (!args.ok) {
    deps.stderr(args.error);
    return 1;
  }

  return withAccessKey(deps, (accessKey) =>
    deployBuiltBundle({
      ...deps,
      accessKey,
      bundlePath: args.bundlePath,
      labelPath: args.bundlePath,
      scriptId: args.scriptId,
    }),
  );
};

export const runDeployEdge = async (deps: DeployEdgeDeps): Promise<number> => {
  const scriptId = parseScriptIdArg(deps.args);
  if (!scriptId.ok) {
    deps.stderr(scriptId.error);
    return 1;
  }

  return withAccessKey(deps, async (accessKey) => {
    deps.stdout("Building edge bundle...");
    const build = await deps.runBuildEdge(deps.cwd);
    if (!build.success) {
      deps.stderr(`build:edge failed with exit code ${build.code}`);
      return 1;
    }

    return deployBuiltBundle({
      ...deps,
      accessKey,
      labelPath: BUNDLE_PATH,
      scriptId: scriptId.scriptId,
    });
  });
};
