/** Reading Square's payment-link delete answer into the one event it proves.
 * Only `cancelled_order_id` ends a link on a 200; a 404 ends it on its own; a
 * refusal that names a paid order ends it too; everything else proves
 * nothing. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import type { FetchResult } from "#shared/fetch.ts";
import { squareLinkEndEventOf } from "#shared/square/link-end.ts";

const answer = (status: number, body: string): FetchResult => ({
  headers: new Headers(),
  ok: status >= 200 && status < 300,
  status,
  text: body,
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
