import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { type EmailMessage, sendEmail } from "#shared/email.ts";
import {
  minimalEmailMessage,
  sendWithProvider,
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
  const inline = {
    content: btoa("png"),
    contentId: "ticket.png",
    contentType: "image/png",
    filename: "ticket.png",
  };
  const msgWithInline: EmailMessage = {
    attachments: [inline],
    html: '<img src="cid:ticket.png">',
    subject: "Tickets",
    text: "Ticket",
    to: validEmail("user@test.com"),
  };

  /** The file a Mailgun form carries under the given field. */
  const mailgunPart = (field: string, index = 0): File => {
    const file = fetch.getFetchFormBody(index).get(field) as File;
    expect(file).toBeInstanceOf(File);
    return file;
  };

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

  test("Mailgun sends each part under the field its role names", async () => {
    await sendWithProvider("mailgun-us", msgWithAttachment);

    const file = mailgunPart("attachment");
    expect([file.name, file.type]).toEqual(["ticket.svg", "image/svg+xml"]);
    expect(fetch.getFetchFormBody().get("inline")).toBe(null);

    await sendWithProvider("mailgun-us", msgWithInline);

    const inlinePart = mailgunPart("inline", 1);
    expect([inlinePart.name, inlinePart.type]).toEqual([
      "ticket.png",
      "image/png",
    ]);
    expect(fetch.getFetchFormBody(1).get("attachment")).toBe(null);
  });

  test("omits attachments field when no attachments provided", async () => {
    await sendEmail(testEmailConfig, minimalEmailMessage);

    const body = fetch.getFetchJsonBody();
    expect("attachments" in body).toBe(false);
  });

  describe("inline parts", () => {
    const JSON_CASES = [
      {
        expected: [
          {
            content: inline.content,
            content_id: "ticket.png",
            filename: "ticket.png",
          },
        ],
        field: "attachments",
        provider: "resend",
      },
      {
        expected: [
          {
            Content: inline.content,
            ContentID: "ticket.png",
            ContentType: "image/png",
            Name: "ticket.png",
          },
        ],
        field: "Attachments",
        provider: "postmark",
      },
      {
        expected: [
          {
            content: inline.content,
            content_id: "ticket.png",
            disposition: "inline",
            filename: "ticket.png",
            type: "image/png",
          },
        ],
        field: "attachments",
        provider: "sendgrid",
      },
    ] as const;

    for (const one of JSON_CASES) {
      test(`${one.provider} names the id that the body's cid reference uses`, async () => {
        await sendWithProvider(one.provider, msgWithInline);

        const body = fetch.getFetchJsonBody();
        expect(body[one.field]).toEqual(one.expected);
      });
    }
  });
});
