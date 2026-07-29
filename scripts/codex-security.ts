#!/usr/bin/env -S deno run -A

import {
  CodexSecurity,
  type LoginResult,
  type ScanOptions,
} from "@openai/codex-security";

const repository = Deno.args[0] ?? ".";
const security = new CodexSecurity();

try {
  await loginWithChatGPT(security);
  const result = await security.run(repository, scanOptions());

  console.log(`Report: ${result.reportPath}`);
  console.log(`Findings: ${result.findings.findings.length}`);
} finally {
  await security.close();
}

async function loginWithChatGPT(security: CodexSecurity): Promise<void> {
  console.log("Starting ChatGPT sign-in...");
  const login = await security.loginChatGPT();
  if (login.authUrl !== null) {
    console.log(`Open this URL to sign in: ${login.authUrl}`);
  }

  const result = await login.wait();
  if (!result.success) {
    throw new Error(loginFailureMessage(result));
  }
  console.log("ChatGPT sign-in complete.");
}

function scanOptions(): ScanOptions {
  return {
    auth: "chatgpt",
    onOutputDirReady(scanDir) {
      console.log(`Scan output: ${scanDir}`);
    },
    onReconnect(attempt, maxAttempts, details) {
      const reason =
        details?.reason === undefined ? "" : ` (${details.reason})`;
      console.log(`Reconnect ${attempt}/${maxAttempts}${reason}`);
    },
    onScanStarted() {
      console.log("Scan started.");
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
