import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  type EmailConfig,
  type EmailMessage,
  sendEmail,
} from "#shared/email.ts";
import {
  minimalEmailMessage,
  testEmailConfig,
  validEmail,
} from "#test-utils/email.ts";
import { useFetchStub } from "#test-utils/mocks.ts";

describe("sendEmail with attachments", () => {
  const fetch = useFetchStub();

  const attachment = {
    content: btoa("<svg>test</svg>"),
    contentType: "image/svg+xml",
    filename: "ticket.svg",
  };
  const msgWithAttachment: EmailMessage = {
    attachments: [attachment],
    html: "<p>Hi</p>",
    subject: "Tickets",
    text: "Hi",
    to: validEmail("user@test.com"),
  };

  const sendWithProvider = (
    provider: EmailConfig["provider"],
    msg: EmailMessage = minimalEmailMessage,
  ) => sendEmail({ ...testEmailConfig, provider }, msg);

  test("Resend includes attachments with filename and content", async () => {
    await sendEmail(testEmailConfig, msgWithAttachment);

    expect(fetch.getFetchJsonBody().attachments).toEqual([
      { content: attachment.content, filename: "ticket.svg" },
    ]);
  });

  test("Postmark includes Attachments with Name, Content, ContentType", async () => {
    await sendWithProvider("postmark", msgWithAttachment);

    expect(fetch.getFetchJsonBody().Attachments).toEqual([
      {
        Content: attachment.content,
        ContentType: "image/svg+xml",
        Name: "ticket.svg",
      },
    ]);
  });

  test("SendGrid includes attachments with content, filename, type, disposition", async () => {
    await sendWithProvider("sendgrid", msgWithAttachment);

    expect(fetch.getFetchJsonBody().attachments).toEqual([
      {
        content: attachment.content,
        disposition: "attachment",
        filename: "ticket.svg",
        type: "image/svg+xml",
      },
    ]);
  });

  test("Mailgun appends attachment as Blob to FormData", async () => {
    await sendWithProvider("mailgun-us", msgWithAttachment);

    const body = fetch.getFetchFormBody();
    const file = body.get("attachment") as File;
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe("ticket.svg");
    expect(file.type).toBe("image/svg+xml");
  });

  test("omits attachments field when no attachments provided", async () => {
    await sendEmail(testEmailConfig, minimalEmailMessage);

    expect(fetch.getFetchJsonBody().attachments).toBeUndefined();
  });
});
