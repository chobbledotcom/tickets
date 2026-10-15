import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PhoneLinks } from "#templates/components/phone-links.tsx";

describe("PhoneLinks", () => {
  test("renders the number with tel: and WhatsApp links when callable", () => {
    const html = String(
      PhoneLinks({ phone: "07700 900000", phonePrefix: "44" }),
    );
    assertStringIncludes(html, "07700 900000");
    assertStringIncludes(html, 'href="tel:+447700900000"');
    assertStringIncludes(html, 'href="https://wa.me/447700900000"');
    assertStringIncludes(html, "whatsapp");
  });

  test("shows the number as plain text when it has no callable digits", () => {
    const html = String(
      PhoneLinks({ phone: "ask reception", phonePrefix: "44" }),
    );
    assertStringIncludes(html, "ask reception");
    assert(
      !html.includes("tel:"),
      "the value should not contain the searched item",
    );
    assert(
      !html.includes("wa.me"),
      "the value should not contain the searched item",
    );
  });

  test("renders nothing when the phone is blank", () => {
    expect(PhoneLinks({ phone: "", phonePrefix: "44" })).toBeNull();
  });
});
