import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  chainSitesOf,
  countBySignature,
  findIssues,
  runsOf,
  signatureOf,
} from "#scripts/check-call-chains/rules.ts";

describe("check-call-chains rules", () => {
  const FLAG = {
    fix: "write one helper for the chain, and call it from each site",
    rule: "repeated-chain",
  };

  test("reads one chain of three named calls with its line", () => {
    const content = "const value = a(b(c(1)));\n";
    expect(chainSitesOf("fixture.ts", content)).toEqual([
      { file: "fixture.ts", line: 1, names: ["a", "b", "c"] },
    ]);
  });

  test("keeps the methods a curried application applies", () => {
    const content =
      'const handler = wrap(config)(guard(policyFor(destination("x"))));\n';
    expect(
      chainSitesOf("fixture.ts", content).map((site) => site.names),
    ).toEqual([["guard", "policyFor", "destination"]]);
  });

  test("names a method call the way the code spells it", () => {
    const content = "obj.render(panel.draw(view.paint(1)))\n";
    expect(
      chainSitesOf("fixture.ts", content).map((site) => site.names),
    ).toEqual([["obj.render", "panel.draw", "view.paint"]]);
  });

  test("keeps the method name of a call on a call result", () => {
    const content = "a(b(c(1).d(2)))\n";
    expect(
      chainSitesOf("fixture.ts", content).map((site) => site.names),
    ).toEqual([["a", "b", "d"]]);
  });

  test("reads no site in a file with no row of brackets", () => {
    expect(chainSitesOf("fixture.ts", "const flat = 1;\n")).toEqual([]);
  });

  test("writes no run for a chain shorter than three methods", () => {
    expect(runsOf(["a", "b"])).toEqual([]);
  });

  test("leaves a chain of two named calls alone", () => {
    expect(chainSitesOf("fixture.ts", "wrap(a)(b(c(x)));\n")).toEqual([]);
  });

  test("reads one site per row, however many calls the row holds", () => {
    const content = "a(b(c(1)))\n";
    expect(chainSitesOf("fixture.ts", content)).toHaveLength(1);
  });

  test("reads each row as its own site", () => {
    const content = "a(b(c(1)))\na(b(c(2)))\n";
    expect(
      chainSitesOf("fixture.ts", content).map((site) => site.line),
    ).toEqual([1, 2]);
  });

  test("leaves a chain in a comment or a string alone", () => {
    const content = '// a(b(c(1)))\nconst note = "a(b(c(1)))";\n';
    expect(chainSitesOf("fixture.ts", content)).toEqual([]);
  });

  test("writes one run of three methods for each window of a longer chain", () => {
    expect(runsOf(["a", "b", "c", "d"])).toEqual(["a(b(c(", "b(c(d("]);
  });

  test("writes a chain the way it reads", () => {
    expect(
      signatureOf(["authPage", "pageGuardFor", "adminDestinationAt"]),
    ).toBe("authPage(pageGuardFor(adminDestinationAt(");
  });

  test("counts a chain only when two or more sites hold it", () => {
    const sites = [
      ...chainSitesOf("a.ts", "a(b(c(1)))\n"),
      ...chainSitesOf("b.ts", "a(b(c(2)))\nd(e(f(3)))\n"),
    ];
    expect(countBySignature(sites)).toEqual({ "a(b(c(": 2 });
  });

  test("passes the sites a chain's recorded count allows", () => {
    const sites = [
      ...chainSitesOf("a.ts", "a(b(c(1)))\n"),
      ...chainSitesOf("b.ts", "a(b(c(2)))\n"),
    ];
    expect(findIssues(sites, { "a(b(c(": 2 })).toEqual([]);
  });

  test("flags each site past a chain's recorded count", () => {
    const sites = [
      ...chainSitesOf("a.ts", "a(b(c(1)))\n"),
      ...chainSitesOf("b.ts", "a(b(c(2)))\n"),
    ];
    expect(findIssues(sites, {})).toEqual([
      { ...FLAG, problem: "a(b(c( repeats at 2 sites", where: "a.ts:1" },
      { ...FLAG, problem: "a(b(c( repeats at 2 sites", where: "b.ts:1" },
    ]);
  });

  test("flags only the site past a recorded count of one", () => {
    const sites = [
      ...chainSitesOf("a.ts", "a(b(c(1)))\n"),
      ...chainSitesOf("b.ts", "a(b(c(2)))\n"),
    ];
    expect(findIssues(sites, { "a(b(c(": 1 })).toEqual([
      { ...FLAG, problem: "a(b(c( repeats at 2 sites", where: "b.ts:1" },
    ]);
  });

  test("asks for a fallen count to be recorded", () => {
    const sites = [
      ...chainSitesOf("a.ts", "a(b(c(1)))\n"),
      ...chainSitesOf("b.ts", "a(b(c(2)))\n"),
    ];
    expect(findIssues(sites, { "a(b(c(": 3 })).toEqual([
      {
        fix: "run `deno task check:call-chains --update` to record the count",
        problem: "a(b(c( repeats at 2 sites, fewer than the recorded 3",
        rule: "improved",
        where: "a(b(c(",
      },
    ]);
  });

  test("asks for the entry of a chain that no longer repeats to be deleted", () => {
    const sites = chainSitesOf("a.ts", "a(b(c(1)))\n");
    expect(findIssues(sites, { "a(b(c(": 2 })).toEqual([
      {
        fix: "delete the entry in scripts/check-call-chains/registry.json",
        problem: "a(b(c( repeats no more",
        rule: "stale-entry",
        where: "a(b(c(",
      },
    ]);
  });
});
