/**
 * The JUnit-report readers behind the run summary: which files deno marked
 * with uncaught errors, and the errored testcases the cancelled-suite
 * attribution reads.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type JunitErroredTest,
  junitErroredTests,
  junitErrorFiles,
} from "#scripts/tap-summary.ts";

/** Parses the report and expects exactly these errored records back. */
const expectErrored = (xml: string, expected: JunitErroredTest[]): void => {
  expect(junitErroredTests(xml)).toEqual(expected);
};

describe("reading deno's JUnit report for uncaught errors", () => {
  test("names the suites whose tests carry error entries", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites name="deno test" tests="3" failures="0" errors="2">',
      '    <testsuite name="./fine.test.ts" tests="1" errors="0" failures="0">',
      '        <testcase name="fine" classname="./fine.test.ts">',
      "        </testcase>",
      "    </testsuite>",
      '    <testsuite name="./uncaught.test.ts" tests="2" errors="2" failures="0">',
      '        <testcase name="starts" classname="./uncaught.test.ts">',
      '            <error message="Cancelled"/>',
      "        </testcase>",
      "    </testsuite>",
      "</testsuites>",
    ].join("\n");

    expect(junitErrorFiles(xml)).toEqual(["./uncaught.test.ts"]);
  });

  test("answers nothing when the report holds no error entries", () => {
    const xml =
      '<testsuite name="./fine.test.ts" tests="1" errors="0" failures="0"></testsuite>';

    expect(junitErrorFiles(xml)).toEqual([]);
  });

  test("reads each errored testcase with its declare site and message", () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<testsuites name="deno test" tests="4" failures="0" errors="1">',
      '    <testsuite name="./probe.test.ts" tests="1" disabled="0" errors="1" failures="0">',
      '        <testcase name="probe suite" classname="./probe.test.ts" time="0.000" line="14" col="1">',
      '            <error message="Cancelled"/>',
      "        </testcase>",
      "    </testsuite>",
      '    <testsuite name="./fine.test.ts" tests="1" disabled="0" errors="0" failures="0">',
      '        <testcase name="fine" classname="./fine.test.ts">',
      "        </testcase>",
      "    </testsuite>",
      "</testsuites>",
    ].join("\n");

    expectErrored(xml, [
      {
        column: 1,
        file: "./probe.test.ts",
        line: 14,
        message: "Cancelled",
        name: "probe suite",
      },
    ]);
  });

  test("answers nothing when no testcase carries an error entry", () => {
    const xml =
      '<testcase name="fine" classname="./fine.test.ts" line="3" col="1"></testcase>';

    expectErrored(xml, []);
  });

  test("skips a self-closing passed testcase before an errored one", () => {
    // quick-junit writes a passed testcase as a self-closing element. The
    // errored record after it must keep its own declare site, and the
    // passed test's attributes must not leak into it.
    const xml = [
      '<testcase name="fine" classname="./fine.test.ts" line="3" col="1"/>',
      '<testcase name="probe suite" classname="./probe.test.ts" line="14" col="1">',
      '            <error message="Cancelled"/>',
      "</testcase>",
    ].join("\n");

    expectErrored(xml, [
      {
        column: 1,
        file: "./probe.test.ts",
        line: 14,
        message: "Cancelled",
        name: "probe suite",
      },
    ]);
  });

  test("keeps a record with absent attributes as empty values", () => {
    // A record the JUnit writer left with no classname, name, line, column,
    // or message still parses, so a malformed report cannot crash the
    // summary that a failing run reads.
    const xml = ["<testcase>", "            <error/>", "</testcase>"].join(
      "\n",
    );

    expectErrored(xml, [
      {
        column: undefined,
        file: "",
        line: undefined,
        message: "",
        name: "",
      },
    ]);
  });

  test("reads non-numeric line and column as absent", () => {
    const xml = [
      '<testcase name="wordy" classname="./w.test.ts" line="top" col="left">',
      '            <error message="Cancelled"/>',
      "</testcase>",
    ].join("\n");

    expectErrored(xml, [
      {
        column: undefined,
        file: "./w.test.ts",
        line: undefined,
        message: "Cancelled",
        name: "wordy",
      },
    ]);
  });

  test("decodes named, numeric, and hexadecimal entities in values", () => {
    const xml = [
      '<testcase name="probe &amp; suite &#65;&#x42;&AMP;&nbsp;&#0;&#99999999999;"',
      '            classname="./p.test.ts" line="1" col="1">',
      '            <error message="Cancelled"/>',
      "</testcase>",
    ].join("\n");

    expect(junitErroredTests(xml).map(({ name }) => name)).toEqual([
      "probe & suite AB&&nbsp;&#0;&#99999999999;",
    ]);
  });

  test("does not read a name out of a classname attribute", () => {
    const xml = [
      '<testcase classname="./only-classname.test.ts" line="2" col="3">',
      '            <error message="Cancelled"/>',
      "</testcase>",
    ].join("\n");

    expectErrored(xml, [
      {
        column: 3,
        file: "./only-classname.test.ts",
        line: 2,
        message: "Cancelled",
        name: "",
      },
    ]);
  });
});
