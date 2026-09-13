/** Direct tests for the ticket view route's own dispatch. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { routeTicketView } from "#routes/tickets/index.ts";

describe("routeTicketView", () => {
  test("claims no route for a method other than GET", async () => {
    const request = new Request("http://localhost/t/some-token", {
      method: "POST",
    });
    const result = await routeTicketView(request, "/t/some-token", "POST");
    expect(result).toBeNull();
  });

  test("claims no route when the path carries no token", async () => {
    const request = new Request("http://localhost/t/", { method: "GET" });
    const result = await routeTicketView(request, "/t/", "GET");
    expect(result).toBeNull();
  });
});
