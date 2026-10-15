import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PhoneLinks } from "#templates/components/phone-links.tsx";
import { says } from "#test-utils/says.ts";

describe("PhoneLinks", () => {
  test("renders the number with tel: and WhatsApp links when callable", () => {
    const html = String(
      PhoneLinks({ phone: "07700 900000", phonePrefix: "44" }),
    );
    says(html, "07700 900000");
    says(html, 'href="tel:+447700900000"');
    says(html, 'href="https://wa.me/447700900000"');
    says(html, "whatsapp");
  });

  test("shows the number as plain text when it has no callable digits", () => {
    const html = String(
      PhoneLinks({ phone: "ask reception", phonePrefix: "44" }),
    );
    says(html, "ask reception");
    assert(!html.includes("tel:"));
    assert(!html.includes("wa.me"));
  });

  test("renders nothing when the phone is blank", () => {
    expect(PhoneLinks({ phone: "", phonePrefix: "44" })).toBeNull();
  });
});
