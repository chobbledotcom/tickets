import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { parseApiJsonBody } from "#routes/api/helpers.ts";

const jsonRequest = (body: string): Request =>
  new Request("http://localhost/api", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

describe("parseApiJsonBody", () => {
  test("returns the parsed object for a valid record body", async () => {
    const result = await parseApiJsonBody(jsonRequest('{"quantity":2}'));
    expect(result).toEqual({ quantity: 2 });
  });

  test("rejects a non-record JSON body (null) with an error response", async () => {
    // Regression: `null` parses fine but is not the record JsonBodyReader
    // promises. It must be rejected here, not passed on to field parsing.
    const result = await parseApiJsonBody(jsonRequest("null"));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  test("rejects a JSON array body with an error response", async () => {
    const result = await parseApiJsonBody(jsonRequest("[1,2,3]"));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });

  test("rejects a malformed JSON body with an error response", async () => {
    const result = await parseApiJsonBody(jsonRequest("{not json"));
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(400);
  });
});
