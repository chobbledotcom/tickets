import { toBase64 } from "#crypto/utils.ts";
import { settings } from "#db/settings.ts";
import type { FreeTextAnswers } from "#shared/email/answers.ts";
import { loadSubmittedAnswerLines } from "#shared/email/answer-receipt.ts";
import {
  deliverRegistrationEmail,
  type EmailAttachment,
  type EmailConfig,
  type EmailEntry,
  type EmailMessage,
  getActiveEmailConfig,
} from "#shared/email.ts";
import {
  type BuyerEntryGroup,
  buildTemplateData,
  buyerEntryGroups,
  collapsedPackageSummary,
  renderEmailContent,
} from "#shared/email-renderer.ts";
import {
  loadRegistrationPackageFacts,
  type RegistrationDeliveryResult,
  type RegistrationPackageFacts,
  waitForRegistrationDeliveries,
} from "#shared/registration-package-facts.ts";
import { generateSvgTicket, type SvgTicketData } from "#shared/svg-ticket.ts";
import { buildCheckinUrl, buildTicketUrl } from "#shared/ticket-url.ts";
import { parseEmail, type ValidEmail } from "#shared/validation/email.ts";

interface RegistrationEmailDelivery {
  attendeeEmail: ValidEmail | null;
  businessEmail: ValidEmail | null;
  config: EmailConfig;
}

export const registrationEmailDelivery = (
  entries: EmailEntry[],
): RegistrationEmailDelivery | null => {
  const config = getActiveEmailConfig();
  if (!config) return null;
  const attendeeRaw = entries[0]?.attendee.email;
  const attendeeEmail = attendeeRaw ? parseEmail(attendeeRaw) : null;
  const businessEmail = parseEmail(settings.businessEmail);
  return attendeeEmail || businessEmail
    ? { attendeeEmail, businessEmail, config }
    : null;
};

const buildSvgTicketData = (
  entry: EmailEntry,
  currency: string,
): SvgTicketData => ({
  attendeeDate: entry.attendee.date,
  checkinUrl: buildCheckinUrl(entry.attendee.ticket_token),
  currency,
  listingDate: entry.listing.date,
  listingLocation: entry.listing.location,
  listingName: entry.listing.name,
  pricePaid: entry.attendee.price_paid,
  purchaseOnly: entry.listing.purchase_only,
  quantity: entry.attendee.quantity,
});

const collapsedSvgTicketData = (
  entries: EmailEntry[],
  currency: string,
  packageName: string,
): SvgTicketData => {
  const summary = collapsedPackageSummary(entries);
  return {
    attendeeDate: summary.widestDated?.attendee.date ?? null,
    checkinUrl: buildCheckinUrl(entries[0]!.attendee.ticket_token),
    currency,
    listingDate: "",
    listingLocation: "",
    listingName: packageName,
    pricePaid: summary.pricePaid,
    purchaseOnly: entries.every((entry) => entry.listing.purchase_only),
    quantity: summary.quantity,
  };
};

const buildTicketAttachments = async (
  groups: readonly BuyerEntryGroup[],
  currency: string,
): Promise<EmailAttachment[]> => {
  const ticketDataList = groups.map((group) =>
    group.hiddenPackageName === undefined
      ? buildSvgTicketData(group.entries[0]!, currency)
      : collapsedSvgTicketData(
          group.entries,
          currency,
          group.hiddenPackageName,
        ),
  );
  const svgs = await Promise.all(
    ticketDataList.map((data) => generateSvgTicket(data)),
  );
  return svgs.map((svg, index) => ({
    content: toBase64(new TextEncoder().encode(svg)),
    contentType: "image/svg+xml",
    filename:
      ticketDataList.length === 1 ? "ticket.svg" : `ticket-${index + 1}.svg`,
  }));
};

export const renderRegistrationEmailMessages = async (
  entries: EmailEntry[],
  currency: string,
  suppliedFacts?: RegistrationPackageFacts,
  freeTexts?: FreeTextAnswers,
): Promise<{
  config: EmailConfig;
  messages: { recipient: "buyer" | "business"; message: EmailMessage }[];
  templateErrors: unknown[];
} | null> => {
  const delivery = registrationEmailDelivery(entries);
  if (!delivery) return null;
  const { attendeeEmail, businessEmail, config } = delivery;
  const facts =
    suppliedFacts === undefined
      ? await loadRegistrationPackageFacts(entries)
      : suppliedFacts;
  const answerLines = await loadSubmittedAnswerLines(entries, freeTexts);
  const ticketUrl = buildTicketUrl(entries);
  const messages: { recipient: "buyer" | "business"; message: EmailMessage }[] = [];
  const templateErrors: unknown[] = [];
  const addRenderedMessage = (
    rendered: Awaited<ReturnType<typeof renderEmailContent>>,
    details: Pick<EmailMessage, "attachments" | "replyTo" | "to">,
    recipient: "buyer" | "business",
  ): void => {
    const { errors, ...content } = rendered;
    templateErrors.push(...errors);
    messages.push({ recipient, message: { ...content, ...details } });
  };

  if (attendeeEmail) {
    const groups = buyerEntryGroups(entries, facts.displays);
    const data = await buildTemplateData(entries, currency, ticketUrl, {
      answerLines,
      hidePackageMembers: true,
      packageDisplays: facts.displays,
    });
    const [rendered, attachments] = await Promise.all([
      renderEmailContent("confirmation", data),
      buildTicketAttachments(groups, currency),
    ]);
    addRenderedMessage(rendered, {
      attachments,
      replyTo: businessEmail || undefined,
      to: attendeeEmail,
    }, "buyer");
  }

  if (businessEmail) {
    const data = await buildTemplateData(entries, currency, ticketUrl, {
      answerLines,
      packageDisplays: facts.displays,
    });
    const rendered = await renderEmailContent("admin", data);
    addRenderedMessage(rendered, {
      replyTo: attendeeEmail || undefined,
      to: businessEmail,
    }, "business");
  }

  return { config, messages, templateErrors };
};

export const sendRegistrationEmails = async (
  entries: EmailEntry[],
  currency: string,
  suppliedFacts?: RegistrationPackageFacts,
  freeTexts?: FreeTextAnswers,
): Promise<RegistrationDeliveryResult> => {
  const prepared = await renderRegistrationEmailMessages(
    entries,
    currency,
    suppliedFacts,
    freeTexts,
  );
  if (!prepared) return { failed: false };
  return await waitForRegistrationDeliveries([
    ...prepared.messages.map(({ message }) =>
      deliverRegistrationEmail(prepared.config, message)
    ),
    ...prepared.templateErrors.map((error) => Promise.reject(error)),
  ]);
};
