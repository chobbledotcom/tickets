import { mapNotNullish } from "#fp";

export const BUNNY_API_BASE = "https://api.bunny.net";
export const BUNDLE_PATH = "bunny-script.ts";
export const USAGE = "Usage: deno task deploy:edge <script-id>";

const ACCESS_KEY_ENV_KEYS = ["BUNNY_ACCESS_KEY", "BUNNY_API_KEY"] as const;

export interface FetchTextResult {
  ok: boolean;
  status: number;
  text: string;
}

export type FetchText = (
  url: string,
  init: RequestInit,
) => Promise<FetchTextResult>;

export type BunnyDeployResult = { ok: true } | { error: string; ok: false };

export interface BuildResult {
  code: number;
  success: boolean;
}

export interface DeployEdgeDeps {
  args: string[];
  bundlePath: string;
  cwd: string;
  fetchText: FetchText;
  getEnv: (key: string) => string | undefined;
  readTextFile: (path: string) => Promise<string>;
  runBuildEdge: (cwd: string) => Promise<BuildResult>;
  stderr: (line: string) => void;
  stdout: (line: string) => void;
}

export const parseScriptIdArg = (
  args: string[],
): { ok: true; scriptId: string } | { error: string; ok: false } => {
  if (args.length !== 1) {
    return { error: USAGE, ok: false };
  }

  const scriptId = args[0]?.trim();
  return scriptId ? { ok: true, scriptId } : { error: USAGE, ok: false };
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

export const uploadScriptCode = (
  scriptId: string,
  code: string,
  accessKey: string,
  fetchText: FetchText,
): Promise<BunnyDeployResult> =>
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

export const deployScriptCode = async (
  scriptId: string,
  code: string,
  accessKey: string,
  fetchText: FetchText,
): Promise<BunnyDeployResult> => {
  const upload = await uploadScriptCode(scriptId, code, accessKey, fetchText);
  if (!upload.ok) return upload;
  return publishScript(scriptId, accessKey, fetchText);
};

export const runDeployEdge = async (deps: DeployEdgeDeps): Promise<number> => {
  const scriptId = parseScriptIdArg(deps.args);
  if (!scriptId.ok) {
    deps.stderr(scriptId.error);
    return 1;
  }

  const accessKey = getAccessKey(deps.getEnv);
  if (!accessKey) {
    deps.stderr(
      "BUNNY_ACCESS_KEY is required in .env (BUNNY_API_KEY also works).",
    );
    return 1;
  }

  deps.stdout("Building edge bundle...");
  const build = await deps.runBuildEdge(deps.cwd);
  if (!build.success) {
    deps.stderr(`build:edge failed with exit code ${build.code}`);
    return 1;
  }

  let code: string;
  try {
    code = await deps.readTextFile(deps.bundlePath);
  } catch (error) {
    deps.stderr(`Failed to read ${deps.bundlePath}: ${String(error)}`);
    return 1;
  }

  deps.stdout(
    `Uploading ${BUNDLE_PATH} to Bunny script ${scriptId.scriptId}...`,
  );
  const deploy = await deployScriptCode(
    scriptId.scriptId,
    code,
    accessKey,
    deps.fetchText,
  );
  if (!deploy.ok) {
    deps.stderr(deploy.error);
    return 1;
  }

  deps.stdout(`Published Bunny script ${scriptId.scriptId}.`);
  return 0;
};
