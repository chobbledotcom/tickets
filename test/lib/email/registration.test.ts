import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import type { EmailConfig } from "#shared/email.ts";
import { sendRegistrationEmails, sendTestEmail } from "#shared/email.ts";
import { updateBusinessEmail } from "#shared/validation/email.ts";
import {
  createTestGroup,
  describeWithEnv,
  makeTestEntry as makeEntry,
  useFetchStub,
  validEmail,
} from "#test-utils";

const testConfig: EmailConfig = {
  apiKey: "re_test_key",
  fromAddress: validEmail("tickets@example.com"),
  provider: "resend",
};

const setupDbEmailConfig = async (
  opts: { businessEmail?: string } = {},
): Promise<void> => {
  await settings.update.email.provider("resend");
  await settings.update.email.apiKey("test-key");
  await settings.update.email.fromAddress("from@test.com");
  if (opts.businessEmail) {
    await updateBusinessEmail(opts.businessEmail);
  }
  settings.invalidateCache();
  await settings.loadKeys(ALL_SETTINGS_KEYS);
};

const setupAndSendRegistration = async (
  opts: { businessEmail?: string } = {},
  entries?: ReturnType<typeof makeEntry>[],
) => {
  await setupDbEmailConfig(opts);
  await sendRegistrationEmails(entries ?? [makeEntry()], "GBP");
};

/** Decode a base64 SVG attachment back to its UTF-8 source. */
const decodeSvgAttachment = (content: string): string => {
  const binary = atob(content);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
};

/** Assert the email body carries exactly one `ticket.svg` attachment and return
 * its decoded SVG source. */
const expectSingleTicketSvg = (body: {
  attachments: { filename: string; content: string }[];
}): string => {
  expect(body.attachments).toHaveLength(1);
  expect(body.attachments[0]!.filename).toBe("ticket.svg");
  return decodeSvgAttachment(body.attachments[0]!.content);
};

describeWithEnv(
  "sendRegistrationEmails",
  {
    db: true,
    env: {
      HOST_EMAIL_API_KEY: undefined,
      HOST_EMAIL_FROM_ADDRESS: undefined,
      HOST_EMAIL_PROVIDER: undefined,
    },
  },
  () => {
    const fetch = useFetchStub();

    test("skips all emails when attendee has no email and no business email set", async () => {
      await setupAndSendRegistration({}, [makeEntry({}, { email: "" })]);
      expect(fetch.callCount()).toBe(0);
    });

    test("sends admin notification when attendee has no email but business email is set", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" }, [
        makeEntry({}, { email: "" }),
      ]);

      expect(fetch.callCount()).toBe(1);
      const body = fetch.getFetchJsonBody();
      expect(body.to).toEqual(["admin@business.com"]);
    });

    test("skips when email not configured", async () => {
      await sendRegistrationEmails([makeEntry()], "GBP");
      expect(fetch.callCount()).toBe(0);
    });

    test("falls back to host email config when no DB email provider", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun-us");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      await sendRegistrationEmails([makeEntry()], "GBP");

      expect(fetch.callCount()).toBe(1);
      const [url] = fetch.getFetchArgs();
      expect(url).toBe("https://api.mailgun.net/v3/example.com/messages");
    });

    test("prefers DB email provider over host email config", async () => {
      Deno.env.set("HOST_EMAIL_PROVIDER", "mailgun-us");
      Deno.env.set("HOST_EMAIL_API_KEY", "key-123");
      Deno.env.set("HOST_EMAIL_FROM_ADDRESS", "noreply@example.com");
      await setupAndSendRegistration();

      expect(fetch.callCount()).toBe(1);
      const [url] = fetch.getFetchArgs();
      expect(url).toBe("https://api.resend.com/emails");
    });

    test("sends confirmation email to attendee", async () => {
      await setupAndSendRegistration();

      expect(fetch.callCount()).toBe(1);
      const body = fetch.getFetchJsonBody();
      expect(body.to).toEqual(["jane@example.com"]);
      expect(body.subject).toContain("Test Listing");
    });

    test("sends both confirmation and admin notification when business email set", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      expect(fetch.callCount()).toBe(2);
      const recipients = fetch.allRecipients();
      expect(recipients).toContainEqual(["jane@example.com"]);
      expect(recipients).toContainEqual(["admin@business.com"]);
    });

    test("uses business email as reply-to on confirmation", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      const body = fetch.findCallBodyByRecipient("jane@example.com");
      expect(body.reply_to).toBe("admin@business.com");
    });

    test("uses attendee email as reply-to on admin notification", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      const body = fetch.findCallBodyByRecipient("admin@business.com");
      expect(body.reply_to).toBe("jane@example.com");
    });

    test("attaches SVG ticket to confirmation email", async () => {
      await setupAndSendRegistration();

      const decoded = expectSingleTicketSvg(fetch.getFetchJsonBody());
      expect(decoded).toContain("<svg");
    });

    test("does not attach tickets to admin notification", async () => {
      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      const body = fetch.findCallBodyByRecipient("admin@business.com");
      expect(body.attachments).toBeUndefined();
    });

    test("collapses a hidden package's tickets into one package-level SVG", async () => {
      const group = await createTestGroup({
        isPackage: true,
        name: "VIP Bundle",
      });
      const { execute } = await import("#shared/db/client.ts");
      await execute(
        "UPDATE groups SET hide_package_listings = 1 WHERE id = ?",
        [group.id],
      );
      const entries = [
        makeEntry(
          { name: "Secret Seat" },
          { package_group_id: group.id, ticket_token: "pkgtok" },
        ),
        makeEntry(
          { name: "Secret Meal" },
          { package_group_id: group.id, ticket_token: "pkgtok" },
        ),
      ];
      await setupAndSendRegistration({}, entries);

      const decoded = expectSingleTicketSvg(fetch.getFetchJsonBody());
      expect(decoded).toContain("VIP Bundle");
      expect(decoded).not.toContain("Secret Seat");
      expect(decoded).not.toContain("Secret Meal");
    });

    test("attaches numbered tickets for multi-listing registration", async () => {
      const entries = [
        makeEntry({ name: "Listing A" }, { ticket_token: "tok1" }),
        makeEntry({ name: "Listing B" }, { ticket_token: "tok2" }),
      ];
      await setupAndSendRegistration({}, entries);

      const body = fetch.getFetchJsonBody();
      expect(body.attachments).toHaveLength(2);
      expect(body.attachments[0].filename).toBe("ticket-1.svg");
      expect(body.attachments[1].filename).toBe("ticket-2.svg");
    });

    test("still sends admin notification when confirmation fetch fails", async () => {
      let callIndex = 0;
      fetch.restubFetch(() => {
        callIndex++;
        if (callIndex === 1) {
          return Promise.resolve(new Response("Error", { status: 500 }));
        }
        return Promise.resolve(new Response());
      });

      await setupAndSendRegistration({ businessEmail: "admin@business.com" });

      // Both calls were attempted (Promise.allSettled)
      expect(fetch.callCount()).toBe(2);
    });
  },
);

describe("sendTestEmail", () => {
  const fetch = useFetchStub();

  test("sends test email and returns status code", async () => {
    const status = await sendTestEmail(
      testConfig,
      validEmail("admin@test.com"),
    );

    expect(status).toBe(200);
    expect(fetch.callCount()).toBe(1);
    const body = fetch.getFetchJsonBody();
    expect(body.to).toEqual(["admin@test.com"]);
    expect(body.subject).toContain("Test email");
  });
});
