import type { TicketCtx } from "./types.ts";

/** The URL a ticket page's form posts to, and falls back to on error. Uses the
 * context's own action URL when set (renewal, order page), otherwise the plain
 * ticket page for the chosen listing slugs. */
export const ticketPageUrl = (ctx: TicketCtx): string =>
  ctx.actionUrl ?? `/ticket/${ctx.slugs.join("+")}`;
