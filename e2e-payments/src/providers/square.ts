import type { Page } from "playwright";
import type { BrowserSession } from "../browser.ts";
import { log } from "../log.ts";
import { assertConfigured, selectProvider } from "./shared.ts";
import type { PaymentProvider } from "./types.ts";

/**
 * Square. Payment confirmation is asserted via the browser return URL
 * (validatePaidSession → processPaymentSession). Square webhooks require a
 * signed subscription created manually in the dashboard against a fixed
 * notification URL, which can't be provisioned for an ephemeral tunnel — so
 * this leg does NOT exercise Square's webhook path; confirmation is the return
 * URL only.
 *
 * Square SANDBOX payment links (CreatePaymentLink → long_url) redirect to
 * Square's "Checkout API Sandbox Testing Panel"
 * (connect.squareupsandbox.com/.../sandbox-testing-panel/…): a stepper
 * (Overview → Test Payment → Checkout → Complete) that simulates the buyer.
 * Its controls are React elements, not <button>/<a>, so they're located by
 * visible text and clicked. The panel is described to the log on entry (and
 * after each click) so any change to its structure is visible in CI.
 */

/**
 * Log every clickable-looking element on the page and its frames — including
 * non-<button> React controls (role=tab/button, tabindex, or cursor:pointer) —
 * with its tag, role, testid, class and text, so CI reveals exactly what the
 * panel offers and how to target it.
 */
const describeClickables = async (page: Page): Promise<void> => {
  for (const root of [page, ...page.frames()]) {
    try {
      const items = (await root.locator("body *").evaluateAll((els) =>
        els
          .map((el) => {
            const h = el as HTMLElement;
            const text = (
              h.innerText ||
              (h as HTMLInputElement).value ||
              ""
            ).trim();
            if (!text || text.length > 50) return null;
            const role = h.getAttribute("role") || "";
            const cursor = getComputedStyle(h).cursor;
            const clickable =
              h.tagName === "BUTTON" ||
              h.tagName === "A" ||
              h.tagName === "INPUT" ||
              ["button", "tab", "link", "menuitem"].includes(role) ||
              h.hasAttribute("onclick") ||
              h.getAttribute("tabindex") !== null ||
              cursor === "pointer";
            if (!clickable) return null;
            return {
              tag: h.tagName.toLowerCase(),
              role,
              testid: h.getAttribute("data-testid") || "",
              cls: (h.getAttribute("class") || "").slice(0, 50),
              text,
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null),
      )) as {
        tag: string;
        role: string;
        testid: string;
        cls: string;
        text: string;
      }[];
      const seen = new Set<string>();
      for (const it of items) {
        const key = `${it.tag}|${it.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        log(
          `      clickable <${it.tag}${it.role ? ` role=${it.role}` : ""}` +
            `${it.testid ? ` testid=${it.testid}` : ""} class="${it.cls}"> "${it.text}"`,
        );
      }
    } catch {
      // frame detached / body unreadable
    }
  }
};

/** Click the first visible element (any tag) whose text matches, across the
 * page and its frames. Returns true if something was clicked. */
const clickByText = async (page: Page, label: string): Promise<boolean> => {
  for (const root of [page, ...page.frames()]) {
    const loc = root.getByText(label, { exact: false }).first();
    try {
      if (await loc.isVisible({ timeout: 1_000 })) {
        await loc.click({ timeout: 5_000 });
        log(`  clicked "${label}"`);
        return true;
      }
    } catch {
      // not present / not clickable here
    }
  }
  return false;
};

/**
 * Drive the Square sandbox testing panel's stepper to complete the simulated
 * payment. The exact control labels are traced to the log (describeClickables)
 * so the sequence can be tightened from CI output. We advance through the
 * likely steps and stop once the browser leaves the panel (back to the app's
 * return URL, which assertPaidBookingConfirmed then checks).
 */
const completeSandboxPanel = async (page: Page): Promise<void> => {
  log("Square sandbox testing panel detected; describing controls…");
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1_500);
  await describeClickables(page);

  // Best-effort stepper walk. Labels are tried in order; after each click we
  // re-describe the panel and bail out as soon as we leave it.
  const steps = ["Test Payment", "Next", "Checkout", "Complete", "Pay", "Done"];
  for (let round = 0; round < 8; round++) {
    if (!page.url().includes("sandbox-testing-panel")) {
      log("  left the sandbox testing panel");
      return;
    }
    let clicked = false;
    for (const label of steps) {
      if (await clickByText(page, label)) {
        clicked = true;
        await page.waitForTimeout(1_500);
        log(`  after "${label}", url=${page.url()}`);
        await describeClickables(page);
        break;
      }
    }
    if (!clicked) break;
  }
  if (page.url().includes("sandbox-testing-panel")) {
    throw new Error(
      "Square sandbox testing panel: could not complete the payment stepper " +
        "(see the described controls above to tighten the click sequence)",
    );
  }
};

export const square: PaymentProvider = {
  name: "square",
  // The Square sandbox account/location has a FIXED currency and rejects a
  // payment link whose amount is in any other currency ("This business can only
  // process payments in GBP but amount was provided in USD"). This sandbox is
  // GBP, so set the site up as GB. Override with SETUP_COUNTRY to match a
  // differently-configured Square sandbox location.
  setupCountry: "GB",

  configure: async (session: BrowserSession, secrets): Promise<void> => {
    await selectProvider(session, "square");
    await session.fill("square_access_token", secrets.token);
    await session.fill("square_location_id", secrets.locationId);
    if (secrets.sandbox === "true") await session.check("square_sandbox");
    await session.clickButton("Update Square Credentials");
    await assertConfigured(session, "square");
  },

  payHostedCheckout: async (page: Page): Promise<void> => {
    await page.waitForLoadState("domcontentloaded");
    await completeSandboxPanel(page);
  },
};
