import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { PhoneLinks } from "#templates/components/phone-links.tsx";

describe("PhoneLinks", () => {
  test("renders the number with tel: and WhatsApp links when callable", () => {
    const html = String(
      PhoneLinks({ phone: "07700 900000", phonePrefix: "44" }),
    );
    expect(html).toContain("07700 900000");
    expect(html).toContain('href="tel:+447700900000"');
    expect(html).toContain('href="https://wa.me/447700900000"');
    expect(html).toContain("whatsapp");
  });

  test("shows the number as plain text when it has no callable digits", () => {
    const html = String(
      PhoneLinks({ phone: "ask reception", phonePrefix: "44" }),
    );
    expect(html).toContain("ask reception");
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("wa.me");
  });

  test("renders nothing when the phone is blank", () => {
    expect(PhoneLinks({ phone: "", phonePrefix: "44" })).toBeNull();
  });
});
