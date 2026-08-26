/**
 * Behavioural tests for the payment "Test Connection" buttons
 * (`src/ui/client/admin/payment-test-buttons.ts`). The script is browser
 * code — it reads `document` and `fetch` from the global scope — so each test
 * installs a fresh happy-dom window plus a scripted `fetch`, boots the
 * script, and presses the real button.
 */

import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { initPaymentTestButtons } from "#src/ui/client/admin/payment-test-buttons.ts";
import {
  createDomInstaller,
  createGlobalStash,
} from "#test-utils/happy-dom.ts";

const stash = createGlobalStash();
const dom = createDomInstaller(["HTMLButtonElement"]);

const SAVE_LABEL = "Test connection";

/** One provider's credentials form as the settings page renders it. */
const formHtml = (provider: string, withToken = true): string => `
  <form id="settings-${provider}">
    ${withToken ? `<input name="csrf_token" type="hidden" value="token-${provider}" />` : ""}
    <button class="secondary" id="${provider}-test-btn" type="button">${SAVE_LABEL}</button>
    <div class="hidden" id="${provider}-test-result"></div>
  </form>`;

type Element = {
  classList: { contains: (name: string) => boolean };
  click: () => void;
  disabled: boolean;
  textContent: string;
};

type Reply = {
  data?: unknown;
  throws?: Error;
  hold?: PromiseWithResolvers<void>;
};

/** Boot the script over one provider's form, with `fetch` scripted. Each
 *  reply answers one press; the last one answers every press after it. */
const harness = (provider: string, replies: Reply[] = [], withToken = true) => {
  const window = dom.installDom(formHtml(provider, withToken));
  const asked: { body: string; url: string }[] = [];
  const queue = [...replies];
  stash.set("fetch", async (url: unknown, init: { body: string }) => {
    asked.push({ body: init.body, url: String(url) });
    const reply = (queue.length > 1 ? queue.shift() : queue[0]) ?? {};
    await reply.hold?.promise;
    if (reply.throws) throw reply.throws;
    return { json: () => Promise.resolve(reply.data ?? { ok: true }) };
  });
  initPaymentTestButtons();
  const find = (id: string): Element =>
    window.document.getElementById(id) as unknown as Element;
  return {
    asked,
    button: find(`${provider}-test-btn`),
    result: find(`${provider}-test-result`),
  };
};

/** Let every pending answer settle before reading the result box. */
const settle = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Press one provider's button and read the lines it wrote. */
const press = async (
  provider: string,
  reply: Reply = {},
): Promise<{
  asked: { body: string; url: string }[];
  button: Element;
  lines: string[];
  result: Element;
}> => {
  const page = harness(provider, [reply]);
  page.button.click();
  await settle();
  return { ...page, lines: page.result.textContent.split("\n") };
};

const validKey = { mode: "test", valid: true };

describe("payment test-connection buttons", () => {
  afterEach(async () => {
    stash.restore();
    await dom.cleanup();
  });

  test("does nothing on a page without a test button", () => {
    dom.installDom("<p>No payment settings here</p>");
    expect(() => initPaymentTestButtons()).not.toThrow();
  });

  test("asks the chosen provider's own test route, with the form's token", async () => {
    const { asked } = await press("sumup", {
      data: {
        apiKey: { valid: false },
        ok: false,
      },
    });
    expect(asked).toEqual([
      { body: "csrf_token=token-sumup", url: "/admin/settings/sumup/test" },
    ]);
  });

  test("shuts the button while it waits, then puts the page's label back", async () => {
    const hold = Promise.withResolvers<void>();
    const page = harness("stripe", [
      { data: { apiKey: validKey, ok: true }, hold },
    ]);

    page.button.click();
    await settle();
    expect(page.button.disabled).toBe(true);
    expect(page.button.textContent).toBe("Testing...");
    expect(page.result.classList.contains("hidden")).toBe(true);

    hold.resolve();
    await settle();
    expect(page.button.disabled).toBe(false);
    expect(page.button.textContent).toBe(SAVE_LABEL);
  });

  test("posts an empty token when the form carries none", async () => {
    const page = harness(
      "stripe",
      [{ data: { apiKey: validKey, ok: true } }],
      false,
    );
    page.button.click();
    await settle();
    expect(page.asked[0]?.body).toBe("csrf_token=");
  });

  // A second press must read as its own answer, not as the first one with
  // more text under it and the first run's colour still on the box.
  test("replaces the last answer rather than adding to it", async () => {
    const page = harness("stripe", [
      { data: { apiKey: validKey, ok: true } },
      { data: { apiKey: { error: "revoked", valid: false }, ok: false } },
    ]);

    page.button.click();
    await settle();
    expect(page.result.textContent.split("\n")[0]).toBe(
      "API Key: Valid (test mode)",
    );
    expect(page.result.classList.contains("success")).toBe(true);

    page.button.click();
    await settle();
    expect(page.result.textContent.split("\n")[0]).toBe(
      "API Key: Invalid - revoked",
    );
    expect(page.result.classList.contains("success")).toBe(false);
    expect(page.result.classList.contains("error")).toBe(true);
  });

  test("puts the last answer away while the next one is asked for", async () => {
    const hold = Promise.withResolvers<void>();
    const page = harness("stripe", [
      { data: { apiKey: { error: "revoked", valid: false }, ok: false } },
      { data: { apiKey: validKey, ok: true }, hold },
    ]);

    page.button.click();
    await settle();
    expect(page.result.classList.contains("error")).toBe(true);

    page.button.click();
    await settle();
    expect(page.result.classList.contains("hidden")).toBe(true);
    expect(page.result.classList.contains("error")).toBe(false);
    expect(page.result.classList.contains("success")).toBe(false);

    hold.resolve();
    await settle();
    expect(page.result.classList.contains("success")).toBe(true);
  });

  test("clears a passing answer as well while the next one is asked for", async () => {
    const hold = Promise.withResolvers<void>();
    const page = harness("stripe", [
      { data: { apiKey: validKey, ok: true } },
      { data: { apiKey: validKey, ok: true }, hold },
    ]);

    page.button.click();
    await settle();
    expect(page.result.classList.contains("success")).toBe(true);

    page.button.click();
    await settle();
    expect(page.result.classList.contains("success")).toBe(false);
    hold.resolve();
    await settle();
  });

  test("shows a passing answer in green", async () => {
    const { result } = await press("stripe", {
      data: { apiKey: validKey, ok: true },
    });
    expect(result.classList.contains("hidden")).toBe(false);
    expect(result.classList.contains("success")).toBe(true);
    expect(result.classList.contains("error")).toBe(false);
    expect(result.classList.contains("stripe-test-result")).toBe(true);
  });

  test("shows a refused answer in red", async () => {
    const { result } = await press("stripe", {
      data: { apiKey: { error: "bad key", valid: false }, ok: false },
    });
    expect(result.classList.contains("success")).toBe(false);
    expect(result.classList.contains("error")).toBe(true);
  });

  test("says so when the test request never lands", async () => {
    const { lines, result } = await press("stripe", {
      throws: new Error("offline"),
    });
    expect(lines).toEqual(["Connection test failed: offline"]);
    expect(result.classList.contains("error")).toBe(true);
  });

  test("says so when the failure carries no message of its own", async () => {
    const { lines } = await press("stripe", {
      throws: "not an error" as unknown as Error,
    });
    expect(lines).toEqual(["Connection test failed: Unknown error"]);
  });

  describe("Stripe", () => {
    for (const [name, apiKey, expected] of [
      ["a working key with its mode", validKey, "API Key: Valid (test mode)"],
      [
        "a refused key and why",
        { error: "expired", valid: false },
        "API Key: Invalid - expired",
      ],
      ["a refused key with no reason", { valid: false }, "API Key: Invalid"],
    ] as const) {
      test(`reports ${name}`, async () => {
        const { lines } = await press("stripe", { data: { apiKey, ok: true } });
        expect(lines[0]).toBe(expected);
      });
    }

    test("lists each webhook endpoint, marking the one we made", async () => {
      const { lines } = await press("stripe", {
        data: {
          apiKey: validKey,
          ok: true,
          ownEndpointId: "we_ours",
          webhooks: [
            {
              enabledEvents: ["checkout.session.completed"],
              endpointId: "we_ours",
              status: "enabled",
              url: "https://ours.example/webhook",
            },
            {
              enabledEvents: ["charge.refunded", "payment_intent.succeeded"],
              endpointId: "we_theirs",
              status: "disabled",
              url: "https://theirs.example/webhook",
            },
          ],
        },
      });
      expect(lines.slice(1)).toEqual([
        "Webhooks: 2 endpoint(s)",
        "  enabled - https://ours.example/webhook (tickets)",
        "  Events: checkout.session.completed",
        "  disabled - https://theirs.example/webhook",
        "  Events: charge.refunded, payment_intent.succeeded",
      ]);
    });

    test("says when Stripe has no webhook endpoints at all", async () => {
      const { lines } = await press("stripe", {
        data: { apiKey: validKey, ok: true, webhooks: [] },
      });
      expect(lines[1]).toBe("Webhooks: None configured");
    });

    test("passes on the reason the webhook list could not be read", async () => {
      const { lines } = await press("stripe", {
        data: { apiKey: validKey, ok: false, webhookError: "no permission" },
      });
      expect(lines[1]).toBe("Webhooks: Error - no permission");
    });
  });

  describe("Square", () => {
    const squareData = (
      location: unknown,
      webhook: unknown = { configured: true },
    ) => ({
      accessToken: { mode: "live", valid: true },
      location,
      ok: true,
      webhook,
    });

    test("names the token, the location and the signature key", async () => {
      const { lines } = await press("square", {
        data: squareData({
          configured: true,
          locationId: "L1",
          name: "The Hall",
          status: "ACTIVE",
        }),
      });
      expect(lines).toEqual([
        "Access Token: Valid (live mode)",
        "Location: The Hall (ACTIVE)",
        "Webhook: Signature key configured",
      ]);
    });

    for (const [name, location, expected] of [
      [
        "falls back to the location id when Square names none",
        { configured: true, locationId: "L1" },
        "Location: L1",
      ],
      [
        "falls back to the location id when Square sends a blank name",
        { configured: true, locationId: "L1", name: "" },
        "Location: L1",
      ],
      [
        "reports a missing location and why",
        { configured: false, error: "not found" },
        "Location: Not configured - not found",
      ],
      [
        "reports a missing location with no reason",
        { configured: false },
        "Location: Not configured",
      ],
    ] as const) {
      test(name, async () => {
        const { lines } = await press("square", { data: squareData(location) });
        expect(lines[1]).toBe(expected);
      });
    }

    for (const [name, webhook, expected] of [
      [
        "reports a missing signature key and why",
        { configured: false, error: "none set" },
        "Webhook: Not configured - none set",
      ],
      [
        "reports a missing signature key with no reason",
        { configured: false },
        "Webhook: Not configured",
      ],
    ] as const) {
      test(name, async () => {
        const { lines } = await press("square", {
          data: squareData({ configured: true, locationId: "L1" }, webhook),
        });
        expect(lines[2]).toBe(expected);
      });
    }
  });

  describe("SumUp", () => {
    // A refused key means the merchant lookup never ran, so the two lines
    // below it would be guesses rather than facts.
    test("says only what a refused key proves", async () => {
      const { lines } = await press("sumup", {
        data: {
          apiKey: { error: "revoked", valid: false },
          currency: { code: "GBP", supported: true },
          merchant: { configured: true, merchantCode: "MC1" },
          ok: false,
        },
      });
      expect(lines).toEqual(["API Key: Invalid - revoked"]);
    });

    test("names the merchant and the currency behind a working key", async () => {
      const { lines } = await press("sumup", {
        data: {
          apiKey: validKey,
          currency: { code: "GBP", supported: true },
          merchant: { configured: true, merchantCode: "MC1" },
          ok: true,
        },
      });
      expect(lines).toEqual([
        "API Key: Valid (test mode)",
        "Merchant: MC1",
        "Currency: GBP (supported)",
      ]);
    });

    for (const [name, merchant, expected] of [
      [
        "reports a missing merchant and why",
        { configured: false, error: "no account" },
        "Merchant: Not configured - no account",
      ],
      [
        "reports a missing merchant with no reason",
        { configured: false },
        "Merchant: Not configured",
      ],
    ] as const) {
      test(name, async () => {
        const { lines } = await press("sumup", {
          data: {
            apiKey: validKey,
            currency: { code: "GBP", supported: true },
            merchant,
            ok: false,
          },
        });
        expect(lines[1]).toBe(expected);
      });
    }

    test("warns when SumUp cannot take the site currency", async () => {
      const { lines } = await press("sumup", {
        data: {
          apiKey: validKey,
          currency: { code: "JPY", supported: false },
          merchant: { configured: true, merchantCode: "MC1" },
          ok: false,
        },
      });
      expect(lines[2]).toBe("Currency: JPY is not supported by SumUp");
    });
  });
});
