/** Shared helpers for the invoice page tests: a booking to invoice, and the
 *  preview form the site serves. */

import { assert } from "@std/assert";
import { textareaBody } from "#templates/components/textarea.tsx";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { adminFormPost } from "#test-utils/session.ts";
import {
  decodeEntities,
  regionOutOf,
} from "#test-utils/test-browser/parsing.ts";

/** A booking that still owes the amount, ready to invoice. */
export const createOwing = async (amount: number): Promise<number> =>
  (await createReservedAttendee(amount)).attendeeId;

/** Send the preview form: the booking and invoice number, and the invoice
 *  text once the operator has edited it. */
export const previewInvoice = async (
  attendeeId: number,
  number: number,
  body?: string,
): Promise<Response> =>
  (
    await adminFormPost("/admin/invoices/preview", {
      attendee_id: String(attendeeId),
      ...(body === undefined ? {} : { body }),
      number: String(number),
    })
  ).response;

/** The words of one served page. */
export const pageText = async (response: Response): Promise<string> =>
  await response.text();

/** The invoice text the preview page offers, as its form posts it back. */
export const previewedBody = (html: string): string => {
  const field = regionOutOf(
    html,
    "<textarea",
    "</textarea>",
    "invoice text field",
  );
  const shown = decodeEntities(field.slice(field.indexOf(">") + 1));
  const spare = textareaBody("");
  assert(
    shown.startsWith(spare),
    "The invoice text field carries no spare newline",
  );
  return shown.slice(spare.length);
};
