import {
  AuthenticationRequiredError,
  CodexSecurity,
  type CodexSecurityConfig,
  type LoginResult,
  type ScanOptions,
} from "@openai/codex-security";
import { consumeFlagValue, walkArguments } from "#scripts/args.ts";

interface SecurityRunResult {
  readonly findings: {
    readonly findings: readonly unknown[];
  };
  readonly reportPath: string;
}

export interface CodexSecurityClient {
  close(): Promise<void>;
  loginChatGPT(): Promise<LoginHandle>;
  loginChatGPTDeviceCode(): Promise<LoginHandle>;
  run(repository: string, options?: ScanOptions): Promise<SecurityRunResult>;
}

interface LoginHandle {
  readonly authUrl: string | null;
  readonly userCode: string | null;
  readonly verificationUrl: string | null;
  wait(): Promise<LoginResult>;
}

interface ScriptOutput {
  log(message: string): void;
}

interface CommandOptions {
  readonly deviceAuth: boolean;
  readonly pythonPath?: string;
  readonly repository: string;
}

const DEVICE_AUTH_FLAG = "--device-auth";
const PYTHON_FLAG = "--python";
const CODEX_SECURITY_PYTHON_ENV = "CODEX_SECURITY_PYTHON";
const PYTHON_ENV = "PYTHON";

interface ScriptEnvironment {
  get(key: string): string | undefined;
}

interface RuntimeDependencies {
  createSecurity(config: CodexSecurityConfig): CodexSecurityClient;
  readonly environment: ScriptEnvironment;
}

const defaultRuntimeDependencies: RuntimeDependencies = {
  createSecurity: (config) => new CodexSecurity(config),
  environment: Deno.env,
};

export async function runCodexSecurity(
  args: readonly string[],
  security?: CodexSecurityClient,
  output: ScriptOutput = console,
  dependencies: RuntimeDependencies = defaultRuntimeDependencies,
): Promise<void> {
  const { deviceAuth, pythonPath, repository } = parseCodexSecurityArgs(args);
  const activeSecurity =
    security ??
    dependencies.createSecurity(
      codexSecurityConfig(pythonPath, dependencies.environment),
    );
  try {
    await runScanAndPrintResult(activeSecurity, repository, output);
  } catch (error) {
    if (!(error instanceof AuthenticationRequiredError)) {
      throw error;
    }

    output.log("No saved ChatGPT sign-in was found.");
    await loginWithChatGPT(activeSecurity, output, deviceAuth);
    await runScanAndPrintResult(activeSecurity, repository, output);
  } finally {
    await activeSecurity.close();
  }
}

export function parseCodexSecurityArgs(
  args: readonly string[],
): CommandOptions {
  let deviceAuth = false;
  let pythonPath: string | undefined;
  let repository: string | undefined;

  walkArguments(args, (arg, index) => {
    if (arg === DEVICE_AUTH_FLAG) {
      deviceAuth = true;
      return;
    }
    const pythonArgCount = consumeFlagValue(
      args,
      arg,
      index,
      PYTHON_FLAG,
      (value) => {
        pythonPath = requiredFlagValue(value, PYTHON_FLAG);
      },
      { equals: true },
    );
    if (pythonArgCount !== null) {
      return pythonArgCount;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown Codex Security option: ${arg}`);
    }
    if (repository !== undefined) {
      throw new Error(`Unexpected Codex Security argument: ${arg}`);
    }
    repository = arg;
    return;
  });

  return {
    deviceAuth,
    ...(pythonPath === undefined ? {} : { pythonPath }),
    repository: repository ?? ".",
  };
}

function codexSecurityConfig(
  pythonPath: string | undefined,
  environment: ScriptEnvironment,
): CodexSecurityConfig {
  const configuredPythonPath =
    pythonPath ??
    environmentValue(environment, CODEX_SECURITY_PYTHON_ENV) ??
    environmentValue(environment, PYTHON_ENV);
  return configuredPythonPath === undefined
    ? {}
    : {
        pythonPath: configuredPythonPath,
      };
}

function environmentValue(
  environment: ScriptEnvironment,
  key: string,
): string | undefined {
  const value = environment.get(key)?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function requiredFlagValue(value: string | undefined, flag: string): string {
  if (
    value === undefined ||
    value.trim().length === 0 ||
    value.startsWith("--")
  ) {
    throw new Error(`${flag} needs a Python path.`);
  }
  return value;
}

async function runScan(
  security: CodexSecurityClient,
  repository: string,
  output: ScriptOutput,
): Promise<SecurityRunResult> {
  return await security.run(repository, scanOptions(output));
}

async function runScanAndPrintResult(
  security: CodexSecurityClient,
  repository: string,
  output: ScriptOutput,
): Promise<void> {
  const result = await runScan(security, repository, output);
  printScanResult(result, output);
}

async function loginWithChatGPT(
  security: CodexSecurityClient,
  output: ScriptOutput,
  useDeviceAuth: boolean,
): Promise<void> {
  if (useDeviceAuth) {
    await loginWithDeviceCode(security, output);
    return;
  }

  const result = await loginWithBrowser(security, output);
  if (result.success) return;

  output.log("Browser sign-in did not finish. Starting device sign-in...");
  await loginWithDeviceCode(security, output);
}

async function loginWithBrowser(
  security: CodexSecurityClient,
  output: ScriptOutput,
): Promise<LoginResult> {
  output.log("Starting ChatGPT sign-in...");
  const login = await security.loginChatGPT();
  if (login.authUrl !== null) {
    output.log(`Open this URL to sign in: ${login.authUrl}`);
  }

  const result = await login.wait();
  if (!result.success) {
    output.log(loginFailureMessage(result));
    return result;
  }
  output.log("ChatGPT sign-in complete.");
  return result;
}

async function loginWithDeviceCode(
  security: CodexSecurityClient,
  output: ScriptOutput,
): Promise<void> {
  output.log("Starting device sign-in...");
  const login = await security.loginChatGPTDeviceCode();
  output.log(
    `Open this URL to sign in: ${requiredLoginValue(
      login.verificationUrl,
      "Codex Security did not provide a device sign-in URL.",
    )}`,
  );
  output.log(
    `Code: ${requiredLoginValue(
      login.userCode,
      "Codex Security did not provide a device sign-in code.",
    )}`,
  );

  const result = await login.wait();
  if (!result.success) {
    throw new Error(loginFailureMessage(result));
  }
  output.log("ChatGPT sign-in complete.");
}

function scanOptions(output: ScriptOutput): ScanOptions {
  return {
    auth: "chatgpt",
    onOutputDirReady(scanDir) {
      output.log(`Scan output: ${scanDir}`);
    },
    onReconnect(attempt, maxAttempts, details) {
      const reason =
        details?.reason === undefined ? "" : ` (${details.reason})`;
      output.log(`Reconnect ${attempt}/${maxAttempts}${reason}`);
    },
    onScanStarted() {
      output.log("Scan started.");
    },
  };
}

function loginFailureMessage(result: LoginResult): string {
  const details = [result.stderr.trim(), result.stdout.trim()]
    .filter((part) => part.length > 0)
    .join("\n");
  return details.length === 0
    ? "ChatGPT sign-in failed."
    : `ChatGPT sign-in failed:\n${details}`;
}

function requiredLoginValue(value: string | null, message: string): string {
  if (value === null) throw new Error(message);
  return value;
}

function printScanResult(
  result: SecurityRunResult,
  output: ScriptOutput,
): void {
  output.log(`Report: ${result.reportPath}`);
  output.log(`Findings: ${result.findings.findings.length}`);
}
