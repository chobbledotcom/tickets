import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { apiError, jsonError } from "#routes/api/cors.ts";
import { apiErrorResponse } from "#shared/rest/crud-api.ts";
import { expectCorsHeaders } from "./helpers.ts";

describe("jsonError", () => {
  test("wraps the message in the { error } envelope via the given responder", async () => {
    const seen: { data: unknown; status?: number }[] = [];
    const respond = jsonError((data, status) => {
      seen.push({ data, status });
      return new Response(null, { status });
    });
    const response = respond("boom", 418);
    expect(response.status).toBe(418);
    expect(seen).toEqual([{ data: { error: "boom" }, status: 418 }]);
  });

  test("defaults the status to 400", () => {
    const respond = jsonError(
      (_data, status) => new Response(null, { status }),
    );
    expect(respond("bad input").status).toBe(400);
  });
});

describe("apiError", () => {
  test("responds with the envelope, the status, and CORS headers", async () => {
    const response = apiError("Listing not found", 404);
    expect(response.status).toBe(404);
    expectCorsHeaders(response);
    expect(await response.json()).toEqual({ error: "Listing not found" });
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
