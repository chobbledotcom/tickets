import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#shared/db/client.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { sendRegistrationEmails } from "#shared/email/registration.ts";
import {
  RegistrationDeliveryError,
  type RegistrationPackageFacts,
} from "#shared/registration-package-facts.ts";
import {
  runWithSubrequestBudget,
  withSubrequestAllowance,
} from "#shared/subrequest-budget.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import { configureTestEmail } from "#test-utils/email.ts";
import { makeTestEntry as makeEntry } from "#test-utils/factories.ts";
import { useFetchStub } from "#test-utils/mocks.ts";
import { countDatabaseCalls } from "#test-utils/subrequest-budget.ts";

const setupAndSendRegistration = async (
  opts: { businessEmail?: string } = {},
  entries?: ReturnType<typeof makeEntry>[],
) => {
  await configureTestEmail(opts);
  return await sendRegistrationEmails(entries ?? [makeEntry()], "GBP");
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

const createHiddenPackage = async (name: string): Promise<number> => {
  const group = await createTestGroup({ isPackage: true, name });
  await execute("UPDATE groups SET hide_package_listings = 1 WHERE id = ?", [
    group.id,
  ]);
  return group.id;
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
      expect(
        await setupAndSendRegistration({}, [makeEntry({}, { email: "" })]),
      ).toEqual({ failed: false });
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
      const groupId = await createHiddenPackage("VIP Bundle");
      const entries = [
        makeEntry(
          { name: "Secret Seat" },
          { date: null, package_group_id: groupId, ticket_token: "pkgtok" },
        ),
        makeEntry(
          { name: "Secret Meal" },
          { date: null, package_group_id: groupId, ticket_token: "pkgtok" },
        ),
      ];
      await setupAndSendRegistration({}, entries);

      const decoded = expectSingleTicketSvg(fetch.getFetchJsonBody());
      expect(decoded).toContain("VIP Bundle");
      expect(decoded).not.toContain("Secret Seat");
      expect(decoded).not.toContain("Secret Meal");
    });

    test("keeps a hidden package's booked date in its ticket", async () => {
      const groupId = await createHiddenPackage("Dated Bundle");
      await setupAndSendRegistration({}, [
        makeEntry(
          { name: "Secret Stay" },
          {
            date: "2026-08-01",
            end_date: "2026-08-03",
            package_group_id: groupId,
          },
        ),
      ]);

      const decoded = expectSingleTicketSvg(fetch.getFetchJsonBody());
      expect(decoded).toContain("1 August 2026");
      expect(decoded).not.toContain("Secret Stay");
    });

    test("uses supplied package displays without reading the database", async () => {
      await configureTestEmail();
      const groupId = 71;
      const entry = makeEntry(
        { id: 72 },
        { package_group_id: groupId, ticket_token: "supplied-package" },
      );
      const facts: RegistrationPackageFacts = {
        displays: new Map([
          [groupId, { hideListings: true, name: "Supplied package" }],
        ]),
        pricingByGroup: new Map(),
      };

      expect(
        await countDatabaseCalls(0, () =>
          sendRegistrationEmails([entry], "GBP", facts),
        ),
      ).toBe(0);
      const body = fetch.getFetchJsonBody();
      expect(body.subject).toContain("Supplied package");
      expect(body.html).not.toContain("Test Listing");
      expect(body.text).not.toContain("Test Listing");
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

    test("returns a template failure after sending the fallback", async () => {
      await configureTestEmail();
      await settings.update.email.template(
        "confirmation",
        "subject",
        "{{ subject | missing_filter }}",
      );
      settings.invalidateCache();
      await settings.loadKeys(ALL_SETTINGS_KEYS);

      const error = await sendRegistrationEmails([makeEntry()], "GBP").catch(
        (reason) => reason,
      );

      expect(error).toBeInstanceOf(RegistrationDeliveryError);
      if (!(error instanceof RegistrationDeliveryError)) throw error;
      expect(error.reasons).toHaveLength(1);
      expect(fetch.callCount()).toBe(1);
      expect(fetch.getFetchJsonBody().subject).toContain("Test Listing");
    });

    test("throws when the email subrequest allowance is exhausted", async () => {
      await configureTestEmail();
      const facts: RegistrationPackageFacts = {
        displays: new Map(),
        pricingByGroup: new Map(),
      };

      const sending = runWithSubrequestBudget(() =>
        withSubrequestAllowance({ database: 50, external: 0, total: 50 }, () =>
          sendRegistrationEmails([makeEntry()], "GBP", facts),
        ),
      );

      const error = await sending.catch((reason) => reason);
      expect(error).toBeInstanceOf(RegistrationDeliveryError);
      if (!(error instanceof RegistrationDeliveryError)) throw error;
      expect(error.reasons).toHaveLength(1);
      expect(error.reasons[0]).toBeInstanceOf(Error);
      if (!(error.reasons[0] instanceof Error)) throw error.reasons[0];
      expect(error.reasons[0].message).toContain(
        "Subrequest allowance exceeded",
      );
      expect(fetch.callCount()).toBe(0);
    });

    test("returns a failed delivery for a network error", async () => {
      await configureTestEmail();
      fetch.restubFetch(() => Promise.reject(new TypeError("Network error")));

      expect(await sendRegistrationEmails([makeEntry()], "GBP")).toEqual({
        failed: true,
      });
    });
  },
);
