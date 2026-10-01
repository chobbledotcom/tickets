/** Reading Square's payment-link delete answer into the one event it proves.
 * Only `cancelled_order_id` ends a link on a 200; a 404 ends it on its own; a
 * refusal that names a paid order ends it too; everything else proves
 * nothing. */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import type { FetchResult } from "#shared/fetch.ts";
import type { SquareClient } from "#shared/square/client.ts";
import {
  endSquareLink,
  squareLinkEndEventOf,
} from "#shared/square/link-end.ts";

const answer = (status: number, body: string): FetchResult => ({
  headers: new Headers(),
  ok: status >= 200 && status < 300,
  status,
  text: body,
});

describe("endSquareLink", () => {
  test("asks the client to end the link and hands back its whole answer", async () => {
    const ended: FetchResult = {
      headers: new Headers(),
      ok: true,
      status: 200,
      text: `{"id":"plink","cancelled_order_id":"ord"}`,
    };
    const cancel = spy((_input: { linkId: string }) => Promise.resolve(ended));

    const given = await endSquareLink(
      () =>
        Promise.resolve({
          checkout: { paymentLinks: { cancel } },
        } as unknown as SquareClient),
      "plink",
    );

    expect(given).toBe(ended);
    expect(cancel.calls[0]?.args[0]).toEqual({ linkId: "plink" });
  });

  test("raises when Square is not configured", async () => {
    await expect(
      endSquareLink(() => Promise.resolve(null), "plink"),
    ).rejects.toThrow("Square is not configured, so no link can be ended");
  });
});

describe("square link delete answers", () => {
  test("a 200 with a cancelled order id proves the link ended", () => {
    expect(
      squareLinkEndEventOf(
        answer(
          200,
          `{"id":"MQASNYL6QB6DFCJ3","cancelled_order_id":"asx8LgZ6MRzD0fObfkJ6obBmSh4F"}`,
        ),
      ),
    ).toBe("delete_answered_cancelled");
  });

  test("a body that is JSON but not an object proves nothing", () => {
    expect(squareLinkEndEventOf(answer(200, `"still payable"`))).toBe(
      "delete_inconclusive",
    );
  });

  test("a 200 without a cancelled order id proves nothing", () => {
    // Square has answered exactly this shape while the link stayed payable
    // and was later paid, so it is a failure, not a success.
    expect(squareLinkEndEventOf(answer(200, `{"id":"5KCK6T4LELEP7BGW"}`))).toBe(
      "delete_inconclusive",
    );
  });

  test("a 404 proves the link is already gone", () => {
    expect(squareLinkEndEventOf(answer(404, `{"errors":[]}`))).toBe(
      "delete_answered_missing",
    );
  });

  test("a refusal that names a completed order ends the row", () => {
    expect(
      squareLinkEndEventOf(
        answer(
          400,
          `{"errors":[{"category":"INVALID_REQUEST_ERROR","code":"BAD_REQUEST","detail":"Order asx8LgZ6MRzD0fObfkJ6obBmSh4F is COMPLETED and cannot be canceled"}]}`,
        ),
      ),
    ).toBe("delete_refused_paid");
  });

  test("a refusal that names a paid order ends the row", () => {
    expect(
      squareLinkEndEventOf(
        answer(
          409,
          `{"errors":[{"category":"INVALID_REQUEST_ERROR","code":"ORDER_NOT_OPEN","detail":"Order asx8LgZ6MRzD0fObfkJ6obBmSh4F has a PAID payment"}]}`,
        ),
      ),
    ).toBe("delete_refused_paid");
  });

  test("a refusal that names an unpaid order proves nothing", () => {
    // "UNPAID" contains "PAID", but an unpaid order can still be ended, so
    // reading it as paid would drop a handle row while the link stays payable.
    expect(
      squareLinkEndEventOf(
        answer(
          400,
          `{"errors":[{"category":"INVALID_REQUEST_ERROR","code":"BAD_REQUEST","detail":"The order is UNPAID and cannot be canceled"}]}`,
        ),
      ),
    ).toBe("delete_inconclusive");
  });

  test("a refusal about anything else proves nothing", () => {
    expect(
      squareLinkEndEventOf(
        answer(
          400,
          `{"errors":[{"category":"INVALID_REQUEST_ERROR","code":"INVALID_VALUE","detail":"The field is wrong"}]}`,
        ),
      ),
    ).toBe("delete_inconclusive");
  });

  test("a body nothing can read proves nothing", () => {
    expect(squareLinkEndEventOf(answer(200, "not json"))).toBe(
      "delete_inconclusive",
    );
    expect(squareLinkEndEventOf(answer(502, "<html>gateway</html>"))).toBe(
      "delete_inconclusive",
    );
  });

  test("an answer with no error list proves nothing", () => {
    expect(squareLinkEndEventOf(answer(400, `{"unrelated":true}`))).toBe(
      "delete_inconclusive",
    );
  });
});
