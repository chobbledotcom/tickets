import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { scanOptions } from "#scripts/jscpd/options.ts";

const COUNTS = "cfg/cpd-counts.json";

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
      check: false,
      config: "cfg/jscpd.json",
      counts: undefined,
      scan: undefined,
      update: false,
    });
  });

  test("reads a config in the joined form and hands jscpd the spaced form", () => {
    expect(scanOptions(["--config=cfg/jscpd.json"]).args).toEqual([
      "--config",
      "cfg/jscpd.json",
    ]);
  });

  test("reads and drops the counts file and the scan name in either form", () => {
    expect(
      scanOptions([
        "--config",
        "cfg/jscpd.json",
        "--counts",
        COUNTS,
        "--scan",
        "main",
      ]),
    ).toMatchObject({
      args: ["--config", "cfg/jscpd.json"],
      counts: COUNTS,
      scan: "main",
    });
    expect(
      scanOptions([
        "--config",
        "cfg/jscpd.json",
        `--counts=${COUNTS}`,
        "--scan=main",
      ]),
    ).toMatchObject({
      args: ["--config", "cfg/jscpd.json"],
      counts: COUNTS,
      scan: "main",
    });
  });

  test("keeps the values of the wrapper flags out of the jscpd arguments", () => {
    expect(
      scanOptions([
        "--counts",
        COUNTS,
        "--scan",
        "main",
        "--config",
        "cfg/jscpd.json",
      ]).args,
    ).toEqual(["--config", "cfg/jscpd.json"]);
  });

  test("checks against the count on --fail-on-new-clones", () => {
    expect(
      scanOptions([
        "--config",
        "cfg/jscpd.json",
        "--counts",
        COUNTS,
        "--scan",
        "main",
        "--fail-on-new-clones",
      ]),
    ).toMatchObject({ args: ["--config", "cfg/jscpd.json"], check: true });
  });

  test("updates without checking when both --update and the check are given", () => {
    expect(
      scanOptions([
        "--config",
        "cfg/jscpd.json",
        "--counts",
        COUNTS,
        "--scan",
        "main",
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

  test("refuses every flag that names no value", () => {
    const refusals: [args: string[], message: string][] = [
      [["--config"], "--config needs a path."],
      [["--config", "--update"], "--config needs a path."],
      [["--config", "jscpd.json", "--counts"], "--counts needs a path."],
      [["--config", "jscpd.json", "--counts="], "--counts needs a path."],
      [
        ["--config", "jscpd.json", "--counts", "--scan", "main"],
        "--counts needs a path.",
      ],
      [["--config", "jscpd.json", "--scan"], "--scan needs a name."],
      [["--config", "jscpd.json", "--scan="], "--scan needs a name."],
      [
        ["--config", "jscpd.json", "--scan", "--update"],
        "--scan needs a name.",
      ],
    ];
    for (const [args, message] of refusals) {
      expect(() => scanOptions(args)).toThrow(message);
    }
  });

  test("refuses a check with no count", () => {
    expect(() =>
      scanOptions(["--config", "cfg/jscpd.json", "--fail-on-new-clones"]),
    ).toThrow(
      "scripts/cpd.ts: --update and --fail-on-new-clones need " +
        "--counts <file> and --scan <name>",
    );
  });

  test("refuses an update with no scan name", () => {
    expect(() =>
      scanOptions([
        "--config",
        "cfg/jscpd.json",
        "--counts",
        COUNTS,
        "--update",
      ]),
    ).toThrow(
      "scripts/cpd.ts: --update and --fail-on-new-clones need " +
        "--counts <file> and --scan <name>",
    );
  });
});
