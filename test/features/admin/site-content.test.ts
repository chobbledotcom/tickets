import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { contentWriteOrError } from "#routes/admin/site-content.ts";
import { runWithFlashContext } from "#shared/flash-context.ts";
import { errorResult, okResult } from "#shared/result.ts";
import { expectErrorFlash } from "#test-utils/assertions.ts";

describe("admin site content write outcomes", () => {
  test("returns the saved value", () => {
    expect(contentWriteOrError(okResult("saved"), "/edit", "Taken")).toBe(
      "saved",
    );
  });

  test("returns not found when the row disappeared", () => {
    const response = contentWriteOrError(
      errorResult("notFound"),
      "/edit",
      "Taken",
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("expected response");
    expect(response.status).toBe(404);
  });

  test("redirects a slug conflict to the form", () => {
    const response = runWithFlashContext(() =>
      contentWriteOrError(errorResult("slugTaken"), "/edit", "Already used"),
    );
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("expected response");
    expectErrorFlash(response, "Already used");
  });
});
