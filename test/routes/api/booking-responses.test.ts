import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  bookingSuccessResponse,
  checkoutFailedResponse,
  checkoutResponse,
  soldOutResponse,
} from "#routes/api/helpers.ts";
import { expectCorsHeaders } from "./helpers.ts";

describe("bookingSuccessResponse", () => {
  test("answers with the ticket link and the balance left to collect", async () => {
    const response = bookingSuccessResponse({
      remaining_balance: 1500,
      ticket_token: "tok123",
    });
    expect(response.status).toBe(200);
    expectCorsHeaders(response);
    expect(await response.json()).toEqual({
      booking: {
        amountOwed: 1500,
        ticketToken: "tok123",
        ticketUrl: "/t/tok123",
      },
    });
  });
});

describe("checkoutResponse", () => {
  test("answers with the hosted checkout URL", async () => {
    const response = checkoutResponse("https://pay.example/session");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      booking: { checkoutUrl: "https://pay.example/session" },
    });
  });
});

describe("soldOutResponse", () => {
  test("answers 409 with the shared sold-out message", async () => {
    const response = soldOutResponse();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Sorry, not enough spots available",
    });
  });
});

describe("checkoutFailedResponse", () => {
  test("answers 400 with the provider's own message when it gave one", async () => {
    const response = checkoutFailedResponse("Card country not supported");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Card country not supported",
    });
  });

  test("answers 500 with the generic message when the provider gave none", async () => {
    const response = checkoutFailedResponse();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "Failed to create payment session",
    });
  });
});
