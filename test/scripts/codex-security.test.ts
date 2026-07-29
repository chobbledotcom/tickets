import {
  AuthenticationRequiredError,
  type ScanOptions,
} from "@openai/codex-security";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type CodexSecurityClient,
  parseCodexSecurityArgs,
  runCodexSecurity,
} from "#scripts/codex-security-lib.ts";

type FakeLogin = Awaited<ReturnType<CodexSecurityClient["loginChatGPT"]>>;

const successfulLogin: FakeLogin = {
  authUrl: "https://auth.openai.com/login",
  userCode: null,
  verificationUrl: null,
  wait: () =>
    Promise.resolve({
      exitCode: 0,
      stderr: "",
      stdout: "",
      success: true,
    }),
};

const successfulDeviceLogin: FakeLogin = {
  ...successfulLogin,
  authUrl: "https://auth.openai.com/device",
  userCode: "ABCD-EFGH",
  verificationUrl: "https://auth.openai.com/device",
};

const failedBrowserLogin: FakeLogin = {
  ...successfulLogin,
  wait: () =>
    Promise.resolve({
      exitCode: 1,
      stderr: "Token exchange failed.",
      stdout: "",
      success: false,
    }),
};

const failedDeviceLogin: FakeLogin = {
  ...successfulDeviceLogin,
  wait: () =>
    Promise.resolve({
      exitCode: 1,
      stderr: "",
      stdout: "",
      success: false,
    }),
};

const deviceLoginWithoutUrl: FakeLogin = {
  ...successfulDeviceLogin,
  verificationUrl: null,
};

const scanResult = {
  findings: { findings: [{ findingId: "one" }] },
  reportPath: "/tmp/codex-security/report.md",
};

class FakeSecurity implements CodexSecurityClient {
  readonly calls: string[] = [];
  private browserLoginFails = false;
  private deviceLoginFails = false;
  private deviceLoginMissingUrl = false;
  private firstScanNeedsLogin = false;
  private scanFails = false;

  constructor(
    options: {
      readonly browserLoginFails?: boolean;
      readonly deviceLoginFails?: boolean;
      readonly deviceLoginMissingUrl?: boolean;
      readonly firstScanNeedsLogin?: boolean;
      readonly scanFails?: boolean;
    } = {},
  ) {
    this.browserLoginFails = options.browserLoginFails ?? false;
    this.deviceLoginFails = options.deviceLoginFails ?? false;
    this.deviceLoginMissingUrl = options.deviceLoginMissingUrl ?? false;
    this.firstScanNeedsLogin = options.firstScanNeedsLogin ?? false;
    this.scanFails = options.scanFails ?? false;
  }

  run(repository: string, options?: ScanOptions): Promise<typeof scanResult> {
    this.calls.push(`run:${repository}`);
    if (this.scanFails) {
      throw new Error("Scan broke.");
    }
    if (this.firstScanNeedsLogin) {
      this.firstScanNeedsLogin = false;
      throw new AuthenticationRequiredError("No credentials were found.");
    }
    options?.onOutputDirReady?.("/tmp/codex-security-scan");
    options?.onReconnect?.(1, 2);
    options?.onReconnect?.(2, 2, { reason: "network" });
    options?.onScanStarted?.();
    return Promise.resolve(scanResult);
  }

  loginChatGPT(): Promise<typeof successfulLogin> {
    this.calls.push("login:browser");
    return Promise.resolve(
      this.browserLoginFails ? failedBrowserLogin : successfulLogin,
    );
  }

  loginChatGPTDeviceCode(): Promise<typeof successfulDeviceLogin> {
    this.calls.push("login:device");
    if (this.deviceLoginMissingUrl) {
      return Promise.resolve(deviceLoginWithoutUrl);
    }
    if (this.deviceLoginFails) {
      return Promise.resolve(failedDeviceLogin);
    }
    return Promise.resolve(successfulDeviceLogin);
  }

  close(): Promise<void> {
    this.calls.push("close");
    return Promise.resolve();
  }
}

const outputLines = (): { log: (message: string) => void; lines: string[] } => {
  const lines: string[] = [];
  return {
    lines,
    log(message) {
      lines.push(message);
    },
  };
};

describe("parseCodexSecurityArgs", () => {
  test("uses the current repository by default", () => {
    expect(parseCodexSecurityArgs([])).toEqual({
      deviceAuth: false,
      repository: ".",
    });
  });

  test("accepts a repository and device auth flag", () => {
    expect(parseCodexSecurityArgs(["--device-auth", "../other"])).toEqual({
      deviceAuth: true,
      repository: "../other",
    });
  });
});

describe("runCodexSecurity", () => {
  test("uses saved ChatGPT auth without asking for a fresh login", async () => {
    const security = new FakeSecurity();
    const output = outputLines();

    await runCodexSecurity(["."], security, output);

    expect(security.calls).toEqual(["run:.", "close"]);
    expect(output.lines).toContain("Report: /tmp/codex-security/report.md");
  });

  test("logs in with ChatGPT when saved auth is missing", async () => {
    const security = new FakeSecurity({ firstScanNeedsLogin: true });
    const output = outputLines();

    await runCodexSecurity(["."], security, output);

    expect(security.calls).toEqual([
      "run:.",
      "login:browser",
      "run:.",
      "close",
    ]);
    expect(output.lines).toContain(
      "Open this URL to sign in: https://auth.openai.com/login",
    );
    expect(output.lines).toContain("Scan output: /tmp/codex-security-scan");
    expect(output.lines).toContain("Reconnect 1/2");
    expect(output.lines).toContain("Reconnect 2/2 (network)");
    expect(output.lines).toContain("Scan started.");
  });

  test("falls back to device sign-in when browser sign-in fails", async () => {
    const security = new FakeSecurity({
      browserLoginFails: true,
      firstScanNeedsLogin: true,
    });
    const output = outputLines();

    await runCodexSecurity(["."], security, output);

    expect(security.calls).toEqual([
      "run:.",
      "login:browser",
      "login:device",
      "run:.",
      "close",
    ]);
    expect(output.lines).toContain("Code: ABCD-EFGH");
  });

  test("uses device sign-in directly when requested", async () => {
    const security = new FakeSecurity({ firstScanNeedsLogin: true });
    const output = outputLines();

    await runCodexSecurity(["--device-auth"], security, output);

    expect(security.calls).toEqual(["run:.", "login:device", "run:.", "close"]);
  });

  test("keeps non-auth scan errors loud", async () => {
    const security = new FakeSecurity({ scanFails: true });
    const output = outputLines();

    await expect(runCodexSecurity(["."], security, output)).rejects.toThrow(
      "Scan broke.",
    );

    expect(security.calls).toEqual(["run:.", "close"]);
  });

  test("throws when device sign-in fails", async () => {
    const security = new FakeSecurity({
      deviceLoginFails: true,
      firstScanNeedsLogin: true,
    });
    const output = outputLines();

    await expect(
      runCodexSecurity(["--device-auth"], security, output),
    ).rejects.toThrow("ChatGPT sign-in failed.");

    expect(security.calls).toEqual(["run:.", "login:device", "close"]);
  });

  test("throws when device sign-in does not provide a URL", async () => {
    const security = new FakeSecurity({
      deviceLoginMissingUrl: true,
      firstScanNeedsLogin: true,
    });
    const output = outputLines();

    await expect(
      runCodexSecurity(["--device-auth"], security, output),
    ).rejects.toThrow("Codex Security did not provide a device sign-in URL.");

    expect(security.calls).toEqual(["run:.", "login:device", "close"]);
  });
});
