import {
  AuthenticationRequiredError,
  CodexSecurity,
  type LoginResult,
  type ScanOptions,
} from "@openai/codex-security";

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
  readonly repository: string;
}

const DEVICE_AUTH_FLAG = "--device-auth";

export async function runCodexSecurity(
  args: readonly string[],
  security: CodexSecurityClient = new CodexSecurity(),
  output: ScriptOutput = console,
): Promise<void> {
  const { deviceAuth, repository } = parseCodexSecurityArgs(args);
  try {
    await runScanAndPrintResult(security, repository, output);
  } catch (error) {
    if (!(error instanceof AuthenticationRequiredError)) {
      throw error;
    }

    output.log("No saved ChatGPT sign-in was found.");
    await loginWithChatGPT(security, output, deviceAuth);
    await runScanAndPrintResult(security, repository, output);
  } finally {
    await security.close();
  }
}

export function parseCodexSecurityArgs(
  args: readonly string[],
): CommandOptions {
  return {
    deviceAuth: args.includes(DEVICE_AUTH_FLAG),
    repository: args.find((arg) => arg !== DEVICE_AUTH_FLAG) ?? ".",
  };
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
