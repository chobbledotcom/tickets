import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseApiJsonBody } from "#routes/api/helpers.ts";

const jsonRequest = (body: string): Request =>
  new Request("http://localhost/api", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const expectInvalidBody = async (body: string): Promise<void> => {
  const result = await parseApiJsonBody(jsonRequest(body));
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Invalid JSON body" });
};

describe("parseApiJsonBody", () => {
  test("returns the parsed object for a valid record body", async () => {
    const result = await parseApiJsonBody(jsonRequest('{"quantity":2}'));
    expect(result).toEqual({ quantity: 2 });
  });

  test("rejects a non-record JSON body (null) with an error response", async () => {
    // Regression: `null` parses fine but is not the record JsonBodyReader
    // promises. It must be rejected here, not passed on to field parsing.
    await expectInvalidBody("null");
  });

  test("rejects a JSON array body with an error response", async () => {
    await expectInvalidBody("[1,2,3]");
  });

  test("rejects a malformed JSON body with an error response", async () => {
    await expectInvalidBody("{not json");
  });
});
