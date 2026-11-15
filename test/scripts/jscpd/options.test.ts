import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scanOptions } from "#scripts/jscpd/options.ts";

const BASELINE = "cfg/.jscpd.baseline.json";

describe("scanOptions", () => {
  test("forwards every other argument to jscpd and reads the config", () => {
    expect(
      scanOptions([
        "--config",
        "cfg/jscpd.json",
        "--reporters",
        "json",
        "--output",
        ".jscpd-report",
      ]),
    ).toEqual({
      args: [
        "--config",
        "cfg/jscpd.json",
        "--reporters",
        "json",
        "--output",
        ".jscpd-report",
      ],
      baseline: undefined,
      check: false,
      config: "cfg/jscpd.json",
      update: false,
    });
  });

  test("reads a config in the joined form and hands jscpd the spaced form", () => {
    expect(scanOptions(["--config=cfg/jscpd.json"]).args).toEqual([
      "--config",
      "cfg/jscpd.json",
    ]);
  });

  test("reads and drops the baseline in either form", () => {
    expect(
      scanOptions(["--config", "cfg/jscpd.json", "--baseline", BASELINE]),
    ).toMatchObject({
      args: ["--config", "cfg/jscpd.json"],
      baseline: BASELINE,
    });
    expect(
      scanOptions(["--config", "cfg/jscpd.json", `--baseline=${BASELINE}`]),
    ).toMatchObject({
      args: ["--config", "cfg/jscpd.json"],
      baseline: BASELINE,
    });
  });

  test("keeps the path after a baseline flag out of the jscpd arguments", () => {
    expect(
      scanOptions(["--baseline", BASELINE, "--config", "cfg/jscpd.json"]).args,
    ).toEqual(["--config", "cfg/jscpd.json"]);
  });

  test("checks against the baseline on --fail-on-new-clones", () => {
    expect(
      scanOptions([
        "--config",
        "cfg/jscpd.json",
        "--baseline",
        BASELINE,
        "--fail-on-new-clones",
      ]),
    ).toMatchObject({ args: ["--config", "cfg/jscpd.json"], check: true });
  });

  test("updates without checking when both --update and the check are given", () => {
    expect(
      scanOptions([
        "--config",
        "cfg/jscpd.json",
        "--baseline",
        BASELINE,
        "--update",
        "--fail-on-new-clones",
      ]),
    ).toMatchObject({ check: false, update: true });
  });

  test("refuses a scan with no config", () => {
    expect(() => scanOptions(["--reporters", "json"])).toThrow(
      "scripts/cpd.ts needs --config <file>",
    );
  });

  test("refuses every flag that names no path", () => {
    const refusals: [args: string[], message: string][] = [
      [["--config"], "--config needs a path."],
      [["--config", "--update"], "--config needs a path."],
      [["--config", "jscpd.json", "--baseline"], "--baseline needs a path."],
      [["--config", "jscpd.json", "--baseline="], "--baseline needs a path."],
      [
        ["--config", "jscpd.json", "--baseline", "--update"],
        "--baseline needs a path.",
      ],
    ];
    for (const [args, message] of refusals) {
      expect(() => scanOptions(args)).toThrow(message);
    }
  });

  test("refuses a check with no baseline", () => {
    expect(() =>
      scanOptions(["--config", "cfg/jscpd.json", "--fail-on-new-clones"]),
    ).toThrow(
      "scripts/cpd.ts: --update and --fail-on-new-clones need --baseline <file>",
    );
  });

  test("refuses an update with no baseline", () => {
    expect(() =>
      scanOptions(["--config", "cfg/jscpd.json", "--update"]),
    ).toThrow(
      "scripts/cpd.ts: --update and --fail-on-new-clones need --baseline <file>",
    );
  });
});
