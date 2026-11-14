/**
 * One write result resolves through its success path, the not-found page, or
 * the refusal renderer.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { operationResponse } from "#shared/rest/operation-response.ts";
import { describeWithEnv } from "#test-utils/db.ts";

const renderError = (error: string) =>
  new Response(`refused: ${error}`, { status: 400 });

describeWithEnv("the write operation response", { db: true }, () => {
  test("a success runs the success path with the result", async () => {
    const answer = await operationResponse(
      { id: 4, ok: true as const },
      (result) => `saved ${result.id}`,
      renderError,
    );

    expect(answer).toBe("saved 4");
  });

  test("a refusal renders its message", async () => {
    const answer = await operationResponse(
      { error: "Name taken", ok: false },
      () => "saved",
      renderError,
    );

    if (!(answer instanceof Response)) throw new Error("expected a response");
    expect([answer.status, await answer.text()]).toEqual([
      400,
      "refused: Name taken",
    ]);
  });

  test("a missing row answers the not-found page", async () => {
    const answer = await operationResponse(
      { notFound: true, ok: false },
      () => "saved",
      renderError,
    );

    if (!(answer instanceof Response)) throw new Error("expected a response");
    expect(answer.status).toBe(404);
    expect(await answer.text()).toContain("<h1>Not Found</h1>");
  });
});
