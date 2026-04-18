/**
 * QR code SVG generation utility
 * Uses uqr (zero-dep, ESM, ~4KB)
 */

import { getQuestionsForEvent } from "#lib/db/questions.ts";
import { parseEventFields } from "#lib/event-fields.ts";
import type { EventWithCount } from "#lib/types.ts";
import { renderSVG } from "uqr";

/**
 * Generate an SVG string for a QR code encoding the given text.
 * Returns a complete <svg> element suitable for inline embedding.
 */
export const generateQrSvg = (text: string): string =>
  renderSVG(text, { border: 1 });

/** Whether this event can send QR code scanners directly to checkout.
 * True when no extra contact fields or questions are required. */
export const eventSupportsDirectCheckout = async (
  event: Pick<EventWithCount, "id" | "fields">,
): Promise<boolean> => {
  if (parseEventFields(event.fields).length > 0) return false;
  const questions = await getQuestionsForEvent(event.id);
  return questions.length === 0;
};
