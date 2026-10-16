// The update page's head markers: what a /read-only page body says about
// update mode and the running build, parsed straight from the strings the
// read-only page renders. The wait behaviour around them lives in
// update-guard.test.ts.
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  updateBuildTagMeta,
  updatePageBuildTag,
  updatePageMeta,
  updatePageState,
} from "#shared/update-guard.ts";

const page = (state: "supported" | "active", buildTag?: string): string =>
  `<html><head>${updatePageMeta(state)}${buildTag === undefined ? "" : updateBuildTagMeta(buildTag)}</head></html>`;

describe("update page marker", () => {
  test("reads active, supported, and unsupported pages", () => {
    expect(updatePageState(page("active"))).toBe("active");
    expect(updatePageState(page("supported"))).toBe("supported");
    expect(updatePageState("<html><head></head></html>")).toBe("unsupported");
    expect(updatePageState("")).toBe("unsupported");
  });

  test("does not read a foreign content value as active", () => {
    expect(
      updatePageState(
        '<meta name="update-in-progress" content="supported"><meta name="x" content="active">',
      ),
    ).toBe("supported");
  });

  test("reads the build tag the page reports", () => {
    expect(updatePageBuildTag(page("active", "v2026-03-28-143022"))).toBe(
      "v2026-03-28-143022",
    );
    expect(updatePageBuildTag(page("active"))).toBeNull();
    expect(updatePageBuildTag("")).toBeNull();
  });
});
