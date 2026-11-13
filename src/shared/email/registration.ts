import { toBase64 } from "#crypto/utils.ts";
import { settings } from "#db/settings.ts";
import {
  type FreeTextAnswers,
  loadOrderAnswerLines,
} from "#shared/email/answers.ts";
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
  type RenderedEmailContent,
  renderEmailContent,
} from "#shared/email-renderer.ts";
import { qrPng } from "#shared/qr.ts";
import {
  loadRegistrationPackageFacts,
  RegistrationDeliveryError,
  type RegistrationDeliveryResult,
  type RegistrationPackageFacts,
  waitForRegistrationDeliveries,
} from "#shared/registration-package-facts.ts";
import {
  generateSvgTicket,
  type SvgTicketData,
  ticketBodyBlock,
} from "#shared/svg-ticket.ts";
import { buildCheckinUrl, buildTicketUrl } from "#shared/ticket-url.ts";
import { parseEmail, type ValidEmail } from "#shared/validation/email.ts";

interface RegistrationEmailDelivery {
  attendeeEmail: ValidEmail | null;
  businessEmail: ValidEmail | null;
  config: EmailConfig;
}

/** The email side's outcome, split by message. The buyer's confirmation is
 * the message a pending flag speaks of. The owner's admin copy is a
 * different message, and no pending flag represents it. */
export type RegistrationEmailResult = RegistrationDeliveryResult & {
  buyerFailed: boolean;
  ownerFailed: boolean;
};

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

/** Whether the buyer's confirmation email will be attempted: the email setup
 * is active and the attendee carries an address. The owner's admin copy is a
 * different message to a different reader. A send that delivers that copy
 * alone has not attempted the buyer's confirmation. It must not clear the
 * buyer's pending-email flag. */
export const buyerConfirmationAttempted = (entries: EmailEntry[]): boolean => {
  const delivery = registrationEmailDelivery(entries);
  return delivery !== null && delivery.attendeeEmail !== null;
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

/** The QR picture the message body shows. The attached file stays the SVG. */
interface QrPicture {
  /** Id the body's `cid:` reference names. */
  contentId: string;
  png: Uint8Array;
}

interface Ticket {
  data: SvgTicketData;
  /** The attached file: ticket.svg, or ticket-<n>.svg for several tickets. */
  filename: string;
  /** Null when the ticket has no check-in, as a purchase-only booking has. */
  qr: QrPicture | null;
  svg: string;
}

const buildTickets = async (
  groups: readonly BuyerEntryGroup[],
  currency: string,
): Promise<Ticket[]> => {
  const ticketDataList = groups.map((group) =>
    group.hiddenPackageName === undefined
      ? buildSvgTicketData(group.entries[0]!, currency)
      : collapsedSvgTicketData(
          group.entries,
          currency,
          group.hiddenPackageName,
        ),
  );
  return await Promise.all(
    ticketDataList.map(async (data, index) => {
      const name =
        ticketDataList.length === 1 ? "ticket" : `ticket-${index + 1}`;
      return {
        data,
        filename: `${name}.svg`,
        qr: data.purchaseOnly
          ? null
          : { contentId: `${name}.png`, png: await qrPng(data.checkinUrl) },
        svg: await generateSvgTicket(data),
      };
    }),
  );
};

const ticketAttachments = (tickets: readonly Ticket[]): EmailAttachment[] =>
  tickets.flatMap((ticket) => [
    {
      content: toBase64(new TextEncoder().encode(ticket.svg)),
      contentType: "image/svg+xml",
      filename: ticket.filename,
    },
    ...(ticket.qr === null
      ? []
      : [
          {
            content: toBase64(ticket.qr.png),
            contentId: ticket.qr.contentId,
            contentType: "image/png",
            filename: ticket.qr.contentId,
          },
        ]),
  ]);

/** The tickets shown after the message in the buyer's HTML email. */
const ticketsHtml = (tickets: readonly Ticket[]): string =>
  tickets
    .map((ticket) => ticketBodyBlock(ticket.data, ticket.qr?.contentId ?? null))
    .join("\n");

export const sendRegistrationEmails = async (
  entries: EmailEntry[],
  currency: string,
  suppliedFacts?: RegistrationPackageFacts,
  freeTexts?: FreeTextAnswers,
): Promise<RegistrationEmailResult> => {
  const delivery = registrationEmailDelivery(entries);
  if (!delivery) {
    return { buyerFailed: false, failed: false, ownerFailed: false };
  }
  const { attendeeEmail, businessEmail, config } = delivery;
  const facts =
    suppliedFacts === undefined
      ? await loadRegistrationPackageFacts(entries)
      : suppliedFacts;
  const answerLines = await loadOrderAnswerLines(entries, freeTexts);
  const ticketUrl = buildTicketUrl(entries);
  const messages: (EmailMessage & { buyerCopy: boolean })[] = [];
  const templateErrors: unknown[] = [];
  const addRenderedMessage = (
    rendered: RenderedEmailContent,
    details: Pick<EmailMessage, "attachments" | "replyTo" | "to">,
    buyerCopy: boolean,
  ): void => {
    const { errors, ...content } = rendered;
    templateErrors.push(...errors);
    messages.push({ ...content, ...details, buyerCopy });
  };

  if (attendeeEmail) {
    const groups = buyerEntryGroups(entries, facts.displays);
    const data = await buildTemplateData(entries, currency, ticketUrl, {
      answerLines,
      hidePackageMembers: true,
      packageDisplays: facts.displays,
    });
    const [rendered, tickets] = await Promise.all([
      renderEmailContent("confirmation", data),
      buildTickets(groups, currency),
    ]);
    addRenderedMessage(
      { ...rendered, html: `${rendered.html}\n${ticketsHtml(tickets)}` },
      {
        attachments: ticketAttachments(tickets),
        replyTo: businessEmail || undefined,
        to: attendeeEmail,
      },
      true,
    );
  }

  if (businessEmail) {
    const data = await buildTemplateData(entries, currency, ticketUrl, {
      answerLines,
      packageDisplays: facts.displays,
    });
    const rendered = await renderEmailContent("admin", data);
    addRenderedMessage(
      rendered,
      {
        replyTo: attendeeEmail || undefined,
        to: businessEmail,
      },
      false,
    );
  }

  // The template errors are not deliveries: a render can carry errors while
  // the message still goes out. They ride the combined result and throw
  // path, and never speak for either side's flag.
  const attempts = messages.map((message) => ({
    buyerCopy: message.buyerCopy,
    promise: deliverRegistrationEmail(config, message),
  }));
  const settled = await Promise.allSettled(attempts.map((one) => one.promise));
  const sideFailed = (buyerCopy: boolean): boolean =>
    settled
      .filter((_, index) => attempts[index]!.buyerCopy === buyerCopy)
      .some(
        (one) =>
          one.status === "rejected" ||
          (one.status === "fulfilled" && !one.value.delivered),
      );
  const buyerFailed = sideFailed(true);
  const ownerFailed = sideFailed(false);
  return {
    ...(await waitForRegistrationDeliveries(
      [
        ...attempts.map((one) => one.promise),
        ...templateErrors.map((error) => Promise.reject(error)),
      ],
      // The combined throw carries the per-message outcomes with it. The
      // flag reconciliation then reads a template error's send as accepted
      // or refused per side.
      (error) =>
        new RegistrationDeliveryError(
          error.failed,
          error.reasons,
          buyerFailed,
          ownerFailed,
        ),
    )),
    buyerFailed,
    ownerFailed,
  };
};
