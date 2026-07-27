import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PR_QUEUE_USAGE, parsePrQueueArgs } from "#scripts/pr-queue/args.ts";

describe("reading the PR queue report's arguments", () => {
  test("asks for the grouped report on this repo by default", () => {
    expect(parsePrQueueArgs([])).toEqual({ help: false, json: false });
  });

  test("asks for JSON", () => {
    expect(parsePrQueueArgs(["--json"])).toEqual({ help: false, json: true });
  });

  test("takes the repo that follows --repo", () => {
    expect(parsePrQueueArgs(["--repo", "owner/name"])).toEqual({
      help: false,
      json: false,
      repo: "owner/name",
    });
  });

  test("takes a repo value that looks like a flag", () => {
    expect(parsePrQueueArgs(["--repo", "--json"]).repo).toBe("--json");
  });

  test("keeps an empty repo value rather than working the repo out", () => {
    expect(parsePrQueueArgs(["--repo", ""]).repo).toBe("");
  });

  test("asks for help with either spelling", () => {
    expect(parsePrQueueArgs(["-h"]).help).toBe(true);
    expect(parsePrQueueArgs(["--help"]).help).toBe(true);
  });

  test("reads several arguments together", () => {
    expect(parsePrQueueArgs(["--json", "--repo", "a/b", "--help"])).toEqual({
      help: true,
      json: true,
      repo: "a/b",
    });
  });

  test("names an argument it does not know", () => {
    expect(parsePrQueueArgs(["--nope"]).error).toBe("Unknown argument: --nope");
  });

  test("strips control characters from an argument it echoes back", () => {
    expect(parsePrQueueArgs(["--[31mred"]).error).toBe(
      "Unknown argument: --[31mred",
    );
  });

  test("keeps the first mistake and stops reading", () => {
    expect(parsePrQueueArgs(["--nope", "--json"])).toEqual({
      error: "Unknown argument: --nope",
      help: false,
      json: false,
    });
  });

  test("says --repo needs a value when nothing follows it", () => {
    expect(parsePrQueueArgs(["--repo"])).toEqual({
      error: "--repo requires a value",
      help: false,
      json: false,
    });
  });

  test("keeps an earlier mistake rather than the missing repo value", () => {
    expect(parsePrQueueArgs(["--nope", "--repo"]).error).toBe(
      "Unknown argument: --nope",
    );
  });

  test("the help text names every option", () => {
    expect(PR_QUEUE_USAGE).toContain("--json");
    expect(PR_QUEUE_USAGE).toContain("--repo owner/name");
    expect(PR_QUEUE_USAGE).toContain("-h, --help");
  });
});
