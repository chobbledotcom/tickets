/**
 * What the "Test Connection" button does, whichever provider it belongs to:
 * where it asks, what it shows while it waits, and how it paints an answer.
 * The words themselves come from the server; these tests pin the showing.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { SAVE_LABEL, settle, usePaymentButtonPage } from "./page.ts";

/** A passing answer with more than one line. */
const passing = {
  data: {
    lines: ["API Key: Valid (test mode)", "Webhooks: None configured"],
    ok: true,
  },
};

describe("pressing a payment test-connection button", () => {
  const page = usePaymentButtonPage();

  test("does nothing on a page without a test button", () => {
    expect(() => page.bare("<p>No payment settings here</p>")).not.toThrow();
  });

  test("does nothing when the page carries no result box", () => {
    expect(() =>
      page.bare(
        '<button id="stripe-test-btn" type="button">Test connection</button>',
      ),
    ).not.toThrow();
  });

  test("asks the chosen provider's own test route, with the form's token", async () => {
    const { asked } = await page.press("sumup", {
      data: { lines: ["API Key: Invalid"], ok: false },
    });
    expect(asked).toEqual([
      { body: "csrf_token=token-sumup", url: "/admin/settings/sumup/test" },
    ]);
  });

  test("posts an empty token when the form carries none", async () => {
    const open = page.open("stripe", [passing], false);
    open.button.click();
    await settle();
    expect(open.asked[0]?.body).toBe("csrf_token=");
  });

  test("shuts the button while it waits, then puts the page's label back", async () => {
    const hold = Promise.withResolvers<void>();
    const open = page.open("stripe", [{ ...passing, hold }]);

    open.button.click();
    await settle();
    expect(open.button.disabled).toBe(true);
    expect(open.button.textContent).toBe("Testing...");
    expect(open.result.classList.contains("hidden")).toBe(true);

    hold.resolve();
    await settle();
    expect(open.button.disabled).toBe(false);
    expect(open.button.textContent).toBe(SAVE_LABEL);
  });

  test("shows the testing label the page ships, even an empty one", async () => {
    const hold = Promise.withResolvers<void>();
    const bare = (_provider: string, withToken: boolean): string =>
      `<form>
        ${withToken ? `<input name="csrf_token" type="hidden" value="t" />` : ""}
        <button data-testing="" id="stripe-test-btn" type="button">${SAVE_LABEL}</button>
        <div class="hidden" data-failed="Connection test failed:" id="stripe-test-result"></div>
      </form>`;
    const open = page.open("stripe", [{ ...passing, hold }], true, bare);

    open.button.click();
    await settle();
    // The attribute is present, so its own (empty) words win over the idle
    // label; the page is the one authority on what the button says.
    expect(open.button.textContent).toBe("");

    hold.resolve();
    await settle();
    expect(open.button.textContent).toBe(SAVE_LABEL);
  });

  test("keeps the page's label while it waits when none other is shipped", async () => {
    const hold = Promise.withResolvers<void>();
    const noLabel = (_provider: string, withToken: boolean): string =>
      `<form>
        ${withToken ? `<input name="csrf_token" type="hidden" value="t" />` : ""}
        <button id="stripe-test-btn" type="button">${SAVE_LABEL}</button>
        <div class="hidden" data-failed="Connection test failed:" id="stripe-test-result"></div>
      </form>`;
    const open = page.open("stripe", [{ ...passing, hold }], true, noLabel);

    open.button.click();
    await settle();
    expect(open.button.textContent).toBe(SAVE_LABEL);

    hold.resolve();
    await settle();
  });

  test("asks Square's own test route the same way", async () => {
    const { asked } = await page.press("square", {
      data: { lines: ["Access Token: Valid (sandbox mode)"], ok: true },
    });
    expect(asked).toEqual([
      { body: "csrf_token=token-square", url: "/admin/settings/square/test" },
    ]);
  });

  test("shows the server's lines, one per row", async () => {
    const { lines } = await page.press("stripe", passing);
    expect(lines).toEqual([
      "API Key: Valid (test mode)",
      "Webhooks: None configured",
    ]);
  });

  test("shows a passing answer in green", async () => {
    const { result } = await page.press("stripe", passing);
    expect(result.classList.contains("hidden")).toBe(false);
    expect(result.classList.contains("success")).toBe(true);
    expect(result.classList.contains("error")).toBe(false);
    expect(result.classList.contains("stripe-test-result")).toBe(true);
  });

  test("shows a refused answer in red", async () => {
    const { result } = await page.press("stripe", {
      data: { lines: ["API Key: Invalid - bad key"], ok: false },
    });
    expect(result.classList.contains("success")).toBe(false);
    expect(result.classList.contains("error")).toBe(true);
  });

  test("says so when the test request never lands", async () => {
    const { lines, result } = await page.press("stripe", {
      throws: new Error("offline"),
    });
    expect(lines).toEqual(["Connection test failed: offline"]);
    expect(result.classList.contains("error")).toBe(true);
  });

  test("says so when the failure carries no message of its own", async () => {
    const { lines } = await page.press("stripe", {
      throws: "not an error" as unknown as Error,
    });
    expect(lines).toEqual(["Connection test failed: Unknown error"]);
  });

  // The button stays wired after a test: an operator who fixes something and
  // presses again gets a fresh answer, not a dead control.
  test("asks again on a second press", async () => {
    const open = page.open("stripe", [passing]);

    open.button.click();
    await settle();
    open.button.click();
    await settle();

    expect(open.asked).toHaveLength(2);
    expect(open.button.disabled).toBe(false);
    expect(open.result.textContent.split("\n")[0]).toBe(
      "API Key: Valid (test mode)",
    );
  });

  // A second press must read as its own answer, not as the first one with
  // more text under it and the first run's colour still on the box.
  test("replaces the last answer rather than adding to it", async () => {
    const refused = {
      data: { lines: ["API Key: Invalid - revoked"], ok: false },
    };
    const open = page.open("stripe", [passing, refused]);

    open.button.click();
    await settle();
    expect(open.result.textContent.split("\n")[0]).toBe(
      "API Key: Valid (test mode)",
    );
    expect(open.result.classList.contains("success")).toBe(true);

    open.button.click();
    await settle();
    expect(open.result.textContent.split("\n")[0]).toBe(
      "API Key: Invalid - revoked",
    );
    expect(open.result.classList.contains("success")).toBe(false);
    expect(open.result.classList.contains("error")).toBe(true);
  });

  test("puts a refused answer away while the next one is asked for", async () => {
    const refused = {
      data: { lines: ["API Key: Invalid - revoked"], ok: false },
    };
    const hold = Promise.withResolvers<void>();
    const open = page.open("stripe", [refused, { ...passing, hold }]);

    open.button.click();
    await settle();
    expect(open.result.classList.contains("error")).toBe(true);

    open.button.click();
    await settle();
    expect(open.result.classList.contains("hidden")).toBe(true);
    expect(open.result.classList.contains("error")).toBe(false);
    expect(open.result.classList.contains("success")).toBe(false);

    hold.resolve();
    await settle();
    expect(open.result.classList.contains("success")).toBe(true);
  });

  test("puts a passing answer away as well while the next one is asked for", async () => {
    const hold = Promise.withResolvers<void>();
    const open = page.open("stripe", [passing, { ...passing, hold }]);

    open.button.click();
    await settle();
    expect(open.result.classList.contains("success")).toBe(true);

    open.button.click();
    await settle();
    expect(open.result.classList.contains("success")).toBe(false);
    hold.resolve();
    await settle();
  });
});
