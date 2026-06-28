import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  awaitTestRequest,
  describeWithEnv,
  expectFlash,
  expectRedirect,
  extractCsrfToken,
  FLASH_TEST_ID,
  flashCookieHeader,
  getHeader,
  installRecordingFetch,
  mockFormRequest,
  mockRequest,
} from "#test-utils";

const BOTPOISON_ENV = {
  BOTPOISON_PUBLIC_KEY: "pk_test_public",
  BOTPOISON_SECRET_KEY: "sk_test_secret",
};

/** Install a fetch stub that answers the Botpoison verify and Resend endpoints.
 * Records request bodies so tests can assert what was sent. */
const installContactFetch = (opts: {
  botpoisonOk: boolean;
  emailStatus?: number;
}) =>
  installRecordingFetch((url) => {
    if (url.includes("api.botpoison.com")) {
      return new Response(JSON.stringify({ ok: opts.botpoisonOk }));
    }
    if (url.includes("api.resend.com")) {
      return new Response(null, { status: opts.emailStatus ?? 200 });
    }
    return null;
  });

/** Configure everything the public contact form needs to be active. */
const activate = async (): Promise<void> => {
  await settings.update.showPublicSite(true);
  await settings.update.businessEmail("owner@example.com");
  await settings.update.contactFormEnabled(true);
  await settings.update.email.provider("resend");
  await settings.update.email.apiKey("re_test_key");
};

/** Fetch /contact and pull the CSRF token out of the rendered form. */
const contactCsrf = async (): Promise<string> => {
  const response = await handleRequest(mockRequest("/contact"));
  const token = extractCsrfToken(await response.text());
  if (!token) throw new Error("No CSRF token on /contact");
  return token;
};

/** Run `body` with the contact Botpoison/email fetch mocked, restoring after. */
const withContactFetch = async (
  opts: Parameters<typeof installContactFetch>[0],
  body: (mock: ReturnType<typeof installContactFetch>) => Promise<void>,
): Promise<void> => {
  const mock = installContactFetch(opts);
  try {
    await body(mock);
  } finally {
    mock.restore();
  }
};

/** POST the contact form with a fresh CSRF token plus the given fields. */
const postContactForm = async (
  fields: Record<string, string>,
): Promise<Response> => {
  const csrf_token = await contactCsrf();
  return handleRequest(mockFormRequest("/contact", { csrf_token, ...fields }));
};

/** Activate the form, GET /contact, assert it renders, and return the HTML. */
const renderActiveContactForm = async (): Promise<string> => {
  await activate();
  const response = await handleRequest(mockRequest("/contact"));
  const html = await response.text();
  expect(response.status).toBe(200);
  expect(html).toContain('action="/contact"');
  return html;
};

/** Set contact page text, GET /contact, and assert the Botpoison widget markup
 * is absent. The "form omitted" tests (toggle off, or no business email) both
 * render the page with contact text but without an active form, so the
 * `data-botpoison-public-key` attribute must not be emitted. */
const expectContactFormOmitted = async (): Promise<void> => {
  await settings.update.contactPageText("Just some text");
  const response = await handleRequest(mockRequest("/contact"));
  const html = await response.text();
  expect(html).not.toContain("data-botpoison-public-key");
};

/** Submit the contact form with an invalid email and assert the server rejects
 * it (redirect + flash) without making any external call. `fields` carries any
 * extra form fields — Botpoison-configured tests pass `_botpoison: "solved"`
 * to prove email validation short-circuits ahead of Botpoison verify. */
const expectInvalidEmailRejected = async (
  mock: ReturnType<typeof installContactFetch>,
  fields: Record<string, string> = {},
): Promise<void> => {
  const response = await postContactForm({
    ...fields,
    email: "not-an-email",
    message: "Hello!",
  });
  expectRedirect(response, "/contact");
  expectFlash(response, "Please enter a valid email address.", false);
  expect(mock.calls.length).toBe(0);
};

describeWithEnv(
  "server (public contact form, Botpoison configured)",
  { db: true, env: BOTPOISON_ENV },
  () => {
    describe("GET /contact", () => {
      test("renders the form with the public key when active", async () => {
        const html = await renderActiveContactForm();
        expect(html).toContain('data-botpoison-public-key="pk_test_public"');
        expect(html).toContain('name="email"');
        expect(html).toContain('name="message"');
      });

      test("loads the bundled contact widget script", async () => {
        await activate();
        const response = await handleRequest(mockRequest("/contact"));
        const html = await response.text();
        expect(html).toContain("/contact.js");
      });

      test("shows the Contact link in the public nav even without text", async () => {
        await activate();
        const response = await handleRequest(mockRequest("/"));
        const html = await response.text();
        expect(html).toContain('href="/contact"');
      });

      test("renders both contact text and the form together", async () => {
        await activate();
        await settings.update.contactPageText("Reach us anytime");
        const response = await handleRequest(mockRequest("/contact"));
        const html = await response.text();
        expect(html).toContain("Reach us anytime");
        expect(html).toContain("data-botpoison-public-key");
      });

      test("shows the website title heading when one is configured", async () => {
        await activate();
        await settings.update.websiteTitle("Acme Tickets");
        const response = await handleRequest(mockRequest("/contact"));
        const html = await response.text();
        expect(html).toContain("<h1>Acme Tickets</h1>");
        expect(html).toContain("<title>Contact - Acme Tickets</title>");
      });

      test("renders a success flash after a redirect", async () => {
        await activate();
        const response = await awaitTestRequest(
          `/contact?flash=${FLASH_TEST_ID}`,
          { cookie: flashCookieHeader("Message sent") },
        );
        const html = await response.text();
        expect(html).toContain("Message sent");
      });

      test("renders an error flash after a redirect", async () => {
        await activate();
        const response = await awaitTestRequest(
          `/contact?flash=${FLASH_TEST_ID}`,
          { cookie: flashCookieHeader("Please enter a message.", false) },
        );
        const html = await response.text();
        expect(html).toContain("Please enter a message.");
      });

      test("404s when the form is off and there is no contact text", async () => {
        await settings.update.showPublicSite(true);
        const response = await handleRequest(mockRequest("/contact"));
        expect(response.status).toBe(404);
      });

      test("omits the form when the toggle is off", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.businessEmail("owner@example.com");
        await expectContactFormOmitted();
      });

      test("omits the form when no business email is set", async () => {
        await settings.update.showPublicSite(true);
        await settings.update.contactFormEnabled(true);
        await expectContactFormOmitted();
      });
    });

    describe("Content-Security-Policy", () => {
      test("allows the Botpoison API in connect-src when configured", async () => {
        const response = await handleRequest(mockRequest("/"));
        const csp = getHeader(response, "content-security-policy");
        expect(csp).toContain("connect-src 'self' https://api.botpoison.com");
      });
    });

    describe("POST /contact", () => {
      test("sends the message and flashes success when verified", async () => {
        await activate();
        await withContactFetch({ botpoisonOk: true }, async (mock) => {
          const response = await postContactForm({
            _botpoison: "solved",
            email: "visitor@external.test",
            message: "Hello!",
          });
          expectRedirect(response, "/contact");
          expectFlash(response, "Message sent");
          const emailCall = mock.emailCall();
          expect(emailCall).toBeDefined();
          expect(emailCall?.body?.to).toEqual(["owner@example.com"]);
          expect(emailCall?.body?.reply_to).toBe("visitor@external.test");
        });
      });

      test("does not send and flashes an error when verification fails", async () => {
        await activate();
        await withContactFetch({ botpoisonOk: false }, async (mock) => {
          const response = await postContactForm({
            _botpoison: "bad",
            email: "visitor@example.com",
            message: "Hello!",
          });
          expectRedirect(response, "/contact");
          expectFlash(
            response,
            expect.stringContaining("Could not verify your submission."),
            false,
          );
          expect(mock.emailCall()).toBeUndefined();
        });
      });

      test("rejects an invalid email without verifying", async () => {
        await activate();
        await withContactFetch({ botpoisonOk: true }, async (mock) => {
          await expectInvalidEmailRejected(mock, { _botpoison: "solved" });
        });
      });

      test("rejects an empty message", async () => {
        await activate();
        await withContactFetch({ botpoisonOk: true }, async (mock) => {
          const response = await postContactForm({
            _botpoison: "solved",
            email: "visitor@example.com",
            message: "   ",
          });
          expectRedirect(response, "/contact");
          expectFlash(response, "Please enter a message.", false);
        });
      });

      test("rejects a message that exceeds the maximum length", async () => {
        await activate();
        await withContactFetch({ botpoisonOk: true }, async (mock) => {
          const response = await postContactForm({
            _botpoison: "solved",
            email: "visitor@example.com",
            message: "x".repeat(MAX_TEXTAREA_LENGTH + 1),
          });
          expectRedirect(response, "/contact");
          expectFlash(
            response,
            expect.stringContaining("characters or fewer"),
            false,
          );
          expect(mock.calls.length).toBe(0);
        });
      });

      test("redirects to login when the public site is disabled", async () => {
        await activate();
        await settings.update.showPublicSite(false);
        const response = await handleRequest(
          mockFormRequest("/contact", {
            email: "visitor@example.com",
            message: "Hello!",
          }),
        );
        expectRedirect(response, "/admin/login");
      });

      test("flashes an error when the message cannot be delivered", async () => {
        await activate();
        await withContactFetch(
          { botpoisonOk: true, emailStatus: 500 },
          async () => {
            const response = await postContactForm({
              _botpoison: "solved",
              email: "visitor@example.com",
              message: "Hello!",
            });
            expectRedirect(response, "/contact");
            expectFlash(
              response,
              expect.stringContaining("could not be sent"),
              false,
            );
          },
        );
      });

      test("redirects with an error on an invalid CSRF token", async () => {
        await activate();
        const response = await handleRequest(
          mockFormRequest("/contact", {
            _botpoison: "solved",
            csrf_token: "invalid",
            email: "visitor@example.com",
            message: "Hello!",
          }),
        );
        expectRedirect(response, "/contact");
        expectFlash(response, expect.stringContaining("Invalid"), false);
      });

      test("404s when the form is not active", async () => {
        await settings.update.showPublicSite(true);
        const response = await handleRequest(
          mockFormRequest("/contact", {
            email: "visitor@example.com",
            message: "Hello!",
          }),
        );
        expect(response.status).toBe(404);
      });
    });

    describe("GET /contact.js", () => {
      test("serves the bundled widget as JavaScript", async () => {
        const response = await handleRequest(mockRequest("/contact.js"));
        expect(response.status).toBe(200);
        expect(getHeader(response, "content-type")).toContain(
          "application/javascript",
        );
      });
    });

    describe("contact route dispatch", () => {
      test("404s sub-paths under /contact", async () => {
        await activate();
        const response = await handleRequest(mockRequest("/contact/extra"));
        expect(response.status).toBe(404);
      });

      test("404s unsupported methods on /contact", async () => {
        await activate();
        const response = await handleRequest(
          mockRequest("/contact", { method: "PUT" }),
        );
        expect(response.status).toBe(404);
      });
    });
  },
);

describeWithEnv(
  "server (public contact form, Botpoison not configured)",
  { db: true },
  () => {
    test("renders the form without the Botpoison widget", async () => {
      const html = await renderActiveContactForm();
      expect(html).toContain('name="email"');
      expect(html).toContain('name="message"');
      expect(html).not.toContain("data-botpoison-public-key");
      expect(html).not.toContain("/contact.js");
    });

    test("accepts a submission without verification and emails the owner", async () => {
      await activate();
      await withContactFetch({ botpoisonOk: false }, async (mock) => {
        const response = await postContactForm({
          email: "visitor@example.com",
          message: "Hello!",
        });
        expectRedirect(response, "/contact");
        expectFlash(response, "Message sent");
        // The Botpoison API must not be called when it is not configured.
        expect(
          mock.calls.some((c) => c.url.includes("api.botpoison.com")),
        ).toBe(false);
        expect(mock.emailCall()?.body?.to).toEqual(["owner@example.com"]);
      });
    });

    test("still validates the email field", async () => {
      await activate();
      await withContactFetch({ botpoisonOk: false }, async (mock) => {
        await expectInvalidEmailRejected(mock);
      });
    });

    test("404s when the form is not enabled", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.businessEmail("owner@example.com");
      const response = await handleRequest(
        mockFormRequest("/contact", {
          email: "visitor@example.com",
          message: "Hello!",
        }),
      );
      expect(response.status).toBe(404);
    });

    test("omits the Botpoison connect-src from the CSP", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/"));
      const csp = getHeader(response, "content-security-policy");
      expect(csp).not.toContain("api.botpoison.com");
    });
  },
);
