import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { linesForRequest } from "#shared/sentry-breadcrumbs.ts";

const line = (message: string) => ({ message });

describe("linesForRequest", () => {
  // An edge isolate serves many requests, and the SDK collects every console
  // line onto one shared scope. A report that carried its neighbours' lines
  // would send a reader down the wrong request.
  test("keeps only the lines the request printed", () => {
    expect(
      linesForRequest("ab12", [
        line("[ab12] [Error] E_DB_QUERY"),
        line("[cd34] [Error] E_EMAIL_SEND"),
        line("[ab12] [Request] GET /listings 200 5ms"),
      ]),
    ).toEqual([
      line("[ab12] [Error] E_DB_QUERY"),
      line("[ab12] [Request] GET /listings 200 5ms"),
    ]);
  });

  test("matches the id at the start, never further along the line", () => {
    expect(
      linesForRequest("ab12", [line('[cd34] [Error] detail="saw ab12 here"')]),
    ).toEqual([]);
  });

  // A short id must not match a longer one that starts the same way.
  test("does not treat one id as the start of another", () => {
    expect(linesForRequest("ab1", [line("[ab12] [Error] E_DB_QUERY")])).toEqual(
      [],
    );
  });

  // Boot and scheduled runs report with no request id, and have no neighbour
  // to be confused with, so their lines are all worth keeping.
  test("keeps every line when there is no request", () => {
    const lines = [line("[Setup] App started"), line("[ab12] [Error] E_DB")];
    expect(linesForRequest(undefined, lines)).toEqual(lines);
  });

  test("drops a line with no message at all", () => {
    expect(linesForRequest("ab12", [{}, line("[ab12] ok")])).toEqual([
      line("[ab12] ok"),
    ]);
  });

  test("returns nothing when the request printed nothing", () => {
    expect(linesForRequest("ab12", [line("[cd34] other")])).toEqual([]);
  });
});
