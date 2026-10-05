/** The return-URL round trip: links carry the operator back, the hidden field
 * hands the URL back to the handler that reads it. */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ReturnUrlField, withReturnUrl } from "#shared/return-url-field.tsx";

describe("withReturnUrl", () => {
  test("appends the encoded return URL to a plain admin path", () => {
    // The ledger entry shape: an edit href returning to the statement page.
    expect(
      withReturnUrl(
        "/admin/ledger/entries/42/edit",
        "/admin/ledger/statement/7",
      ),
    ).toBe(
      "/admin/ledger/entries/42/edit?return_url=%2Fadmin%2Fledger%2Fstatement%2F7",
    );
  });

  test("keeps the path when the return URL holds query-like characters", () => {
    // The attendee note shape: the return target itself carries a filter.
    expect(
      withReturnUrl("/admin/attendee/5/note/9/delete", "/admin/attendee/5?a=1"),
    ).toBe(
      "/admin/attendee/5/note/9/delete?return_url=%2Fadmin%2Fattendee%2F5%3Fa%3D1",
    );
  });
});

describe("ReturnUrlField", () => {
  test("renders the URL into a hidden input for the form handler", () => {
    expect(String(ReturnUrlField({ returnUrl: "/admin/ledger" }))).toBe(
      '<input name="return_url" type="hidden" value="/admin/ledger">',
    );
  });

  test("renders nothing when there is no return URL", () => {
    expect(String(ReturnUrlField({}))).toBe("");
  });
});
