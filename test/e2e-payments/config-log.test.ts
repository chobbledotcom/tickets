/** Direct tests for the config and log helpers. */

import { assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  config,
  type EnvLookup,
  type HarnessConfig,
  needsTunnel,
  newBookerIdentity,
  randomId,
  randomOwnerCredentials,
  readConfig,
} from "#e2e/config.ts";
import { fail, log, step, warn } from "#e2e/log.ts";

/** Build an env lookup from a plain record of raw values. */
const lookupOf =
  (values: Record<string, string | undefined>): EnvLookup =>
  (key) =>
    values[key];

describe("randomId", () => {
  it("produces a lowercase hex string twice the byte length", () => {
    expect(randomId()).toMatch(/^[0-9a-f]{10}$/);
    expect(randomId(3)).toMatch(/^[0-9a-f]{6}$/);
  });

  it("produces unique values across calls", () => {
    expect(randomId()).not.toBe(randomId());
  });
});

describe("randomOwnerCredentials", () => {
  it("returns a username starting with e2e- and a strong password", () => {
    const cred = randomOwnerCredentials();
    expect(cred.username.startsWith("e2e-")).toBe(true);
    expect(cred.password.length).toBeGreaterThan(8);
  });
});

describe("newBookerIdentity", () => {
  it("builds a unique email and name from the run id", () => {
    const id1 = newBookerIdentity("abc123");
    assertStringIncludes(id1.email, "abc123");
    assertStringIncludes(id1.email, "@mailinator.com");
    assertStringIncludes(id1.name, "E2E Booker");
    const id2 = newBookerIdentity("abc123");
    expect(id1.email).not.toBe(id2.email);
  });
});

describe("needsTunnel", () => {
  it("is false for the free target by default", () => {
    expect(needsTunnel("free")).toBe(false);
  });

  it("is true for paid targets by default", () => {
    expect(needsTunnel("stripe")).toBe(true);
    expect(needsTunnel("square")).toBe(true);
    expect(needsTunnel("sumup")).toBe(true);
  });

  it("honours a forced tunnel value over the target default", () => {
    expect(needsTunnel("free", "1")).toBe(true);
    expect(needsTunnel("free", "true")).toBe(true);
    expect(needsTunnel("stripe", "0")).toBe(false);
    expect(needsTunnel("stripe", "yes")).toBe(false);
  });
});

describe("readConfig env parsing", () => {
  it("trims text values and falls back when blank or unset", () => {
    expect(readConfig(lookupOf({})).artifactsDir).toBe("artifacts");
    expect(
      readConfig(lookupOf({ E2E_ARTIFACTS_DIR: "  out  " })).artifactsDir,
    ).toBe("out");
    expect(
      readConfig(lookupOf({ E2E_ARTIFACTS_DIR: "   " })).artifactsDir,
    ).toBe("artifacts");
  });

  it("parses boolean values as 1, true, or yes in any case", () => {
    expect(readConfig(lookupOf({})).headless).toBe(true);
    expect(readConfig(lookupOf({ HEADLESS: "1" })).headless).toBe(true);
    expect(readConfig(lookupOf({ HEADLESS: "TRUE" })).headless).toBe(true);
    expect(readConfig(lookupOf({ HEADLESS: "yes" })).headless).toBe(true);
    expect(readConfig(lookupOf({ HEADLESS: "no" })).headless).toBe(false);
  });

  it("parses numeric values and falls back when absent or not a number", () => {
    expect(readConfig(lookupOf({})).unitPrice).toBe(137);
    expect(readConfig(lookupOf({ E2E_UNIT_PRICE: "999" })).unitPrice).toBe(999);
    expect(readConfig(lookupOf({ E2E_UNIT_PRICE: "abc" })).unitPrice).toBe(137);
    expect(readConfig(lookupOf({ E2E_UNIT_PRICE: "" })).unitPrice).toBe(137);
  });
});

/** One snapshot field: the env key it reads, the raw probe the test feeds, and
 * the value an unset key leaves. */
interface SnapshotField {
  field: keyof HarnessConfig;
  key: string;
  kind: "num" | "bool" | "text";
  probe: string;
  unset: string | number | boolean | undefined;
}

/** Every snapshot field, so a mistyped or cross-wired env key fails here
 * instead of silently falling back to the default in a nightly run. */
const SNAPSHOT_FIELDS: readonly SnapshotField[] = [
  {
    field: "actionTimeoutMs",
    key: "E2E_ACTION_TIMEOUT_MS",
    kind: "num",
    probe: "101",
    unset: 15_000,
  },
  {
    field: "artifactsDir",
    key: "E2E_ARTIFACTS_DIR",
    kind: "text",
    probe: "probe-artifacts",
    unset: "artifacts",
  },
  {
    field: "chromiumExecutable",
    key: "CHROMIUM_EXECUTABLE",
    kind: "text",
    probe: "probe-chromium",
    unset: undefined,
  },
  {
    field: "cloudflaredBin",
    key: "CLOUDFLARED_BIN",
    kind: "text",
    probe: "probe-cloudflared",
    unset: "cloudflared",
  },
  {
    field: "dbEncryptionKey",
    key: "DB_ENCRYPTION_KEY",
    kind: "text",
    probe: "probe-encryption-key",
    unset: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  },
  {
    field: "denoBin",
    key: "DENO_BIN",
    kind: "text",
    probe: "probe-deno",
    unset: "deno",
  },
  {
    field: "forceTunnel",
    key: "E2E_TUNNEL",
    kind: "text",
    probe: "probe-tunnel",
    unset: undefined,
  },
  { field: "headless", key: "HEADLESS", kind: "bool", probe: "0", unset: true },
  {
    field: "hostedPaymentStepTimeoutMs",
    key: "E2E_HOSTED_PAYMENT_TIMEOUT_MS",
    kind: "num",
    probe: "102",
    unset: 240_000,
  },
  {
    field: "navTimeoutMs",
    key: "E2E_NAV_TIMEOUT_MS",
    kind: "num",
    probe: "103",
    unset: 45_000,
  },
  {
    field: "paymentConfirmTimeoutMs",
    key: "E2E_PAYMENT_CONFIRM_TIMEOUT_MS",
    kind: "num",
    probe: "104",
    unset: 90_000,
  },
  {
    field: "sentryUrl",
    key: "SENTRY_URL",
    kind: "text",
    probe: "probe-sentry",
    unset: undefined,
  },
  {
    field: "serverBootTimeoutMs",
    key: "E2E_SERVER_BOOT_TIMEOUT_MS",
    kind: "num",
    probe: "105",
    unset: 60_000,
  },
  {
    field: "setupCountry",
    key: "SETUP_COUNTRY",
    kind: "text",
    probe: "probe-country",
    unset: "GB",
  },
  {
    field: "startupTimeoutMs",
    key: "E2E_STARTUP_TIMEOUT_MS",
    kind: "num",
    probe: "106",
    unset: 300_000,
  },
  {
    field: "stepTimeoutMs",
    key: "E2E_STEP_TIMEOUT_MS",
    kind: "num",
    probe: "107",
    unset: 120_000,
  },
  {
    field: "teardownTimeoutMs",
    key: "E2E_TEARDOWN_TIMEOUT_MS",
    kind: "num",
    probe: "108",
    unset: 120_000,
  },
  {
    field: "tunnelAttempts",
    key: "E2E_TUNNEL_ATTEMPTS",
    kind: "num",
    probe: "109",
    unset: 3,
  },
  {
    field: "tunnelTimeoutMs",
    key: "E2E_TUNNEL_TIMEOUT_MS",
    kind: "num",
    probe: "110",
    unset: 60_000,
  },
  {
    field: "unitPrice",
    key: "E2E_UNIT_PRICE",
    kind: "num",
    probe: "111",
    unset: 137,
  },
];

/** The value a probe parses to for its field's kind. */
const PROBED_BY_KIND: Record<
  SnapshotField["kind"],
  (probe: string) => string | number | boolean
> = {
  bool: () => false,
  num: Number,
  text: (probe) => probe,
};

describe("readConfig field mapping", () => {
  const baseline = readConfig(lookupOf({}));

  it("names every field of the snapshot exactly once", () => {
    expect(SNAPSHOT_FIELDS.map((row) => row.field).sort()).toEqual(
      Object.keys(baseline).sort(),
    );
  });

  it("leaves the documented default when a key is unset", () => {
    for (const row of SNAPSHOT_FIELDS) {
      expect(baseline[row.field]).toBe(row.unset);
    }
  });

  it("lands each probe on its own field and no other", () => {
    const probed = readConfig(
      lookupOf(
        Object.fromEntries(SNAPSHOT_FIELDS.map((row) => [row.key, row.probe])),
      ),
    );
    for (const row of SNAPSHOT_FIELDS) {
      expect(probed[row.field]).toBe(PROBED_BY_KIND[row.kind](row.probe));
    }
  });
});

describe("config defaults", () => {
  it("has a non-zero unit price and a test encryption key", () => {
    expect(config.unitPrice).toBeGreaterThan(0);
    expect(config.dbEncryptionKey.length).toBeGreaterThan(0);
    expect(config.stepTimeoutMs).toBeGreaterThan(0);
    expect(config.startupTimeoutMs).toBeGreaterThan(config.stepTimeoutMs);
  });
});

describe("log functions", () => {
  it("step writes a timestamped line with the prefix arrow", () => {
    const original = console.log;
    let captured = "";
    console.log = (msg: string) => (captured = msg);
    try {
      step("hello");
    } finally {
      console.log = original;
    }
    assertStringIncludes(captured, "▸");
    assertStringIncludes(captured, "hello");
  });

  it("warn writes to console.warn with an exclamation", () => {
    const original = console.warn;
    let captured = "";
    console.warn = (msg: string) => (captured = msg);
    try {
      warn("careful");
    } finally {
      console.warn = original;
    }
    assertStringIncludes(captured, "!");
    assertStringIncludes(captured, "careful");
  });

  it("fail writes to console.error with a cross", () => {
    const original = console.error;
    let captured = "";
    console.error = (msg: string) => (captured = msg);
    try {
      fail("broken");
    } finally {
      console.error = original;
    }
    assertStringIncludes(captured, "✖");
    assertStringIncludes(captured, "broken");
  });

  it("log writes to console.log with a timestamp", () => {
    const original = console.log;
    let captured = "";
    console.log = (msg: string) => (captured = msg);
    try {
      log("plain");
    } finally {
      console.log = original;
    }
    assertStringIncludes(captured, "plain");
  });
});
