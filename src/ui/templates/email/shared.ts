/**
 * Shared helpers for email templates
 */

import { map } from "#fp";
import type { EmailEntry } from "#lib/email.ts";

export type EmailContent = { subject: string; html: string; text: string };

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

export const eventNames = (entries: EmailEntry[]): string =>
  listFormat.format(map(({ event }: EmailEntry) => event.name)(entries));
