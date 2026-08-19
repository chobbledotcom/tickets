import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { apiError, apiErrorResponse } from "#routes/api/cors.ts";
import { expectCorsHeaders } from "#test-utils/api/helpers.ts";

describe("apiError", () => {
  test("responds with the envelope, the status, and CORS headers", async () => {
    const response = apiError("Listing not found", 404);
    expect(response.status).toBe(404);
    expectCorsHeaders(response);
    expect(await response.json()).toEqual({ error: "Listing not found" });
  });

  test("defaults the status to 400", async () => {
    const response = apiError("bad input");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad input" });
  });
});

describe("apiErrorResponse", () => {
  test("responds with the envelope and no CORS headers", async () => {
    const response = apiErrorResponse("Invalid signature", 401);
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.json()).toEqual({ error: "Invalid signature" });
  });

  test("defaults the status to 400", async () => {
    const response = apiErrorResponse("Invalid JSON");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON" });
  });
});
