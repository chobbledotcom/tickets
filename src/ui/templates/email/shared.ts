/**
 * Shared helpers for email templates
 */

import { map } from "#fp";
import type { EmailEntry } from "#shared/email.ts";

export type EmailContent = { subject: string; html: string; text: string };

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

export const listingNames = (entries: EmailEntry[]): string =>
  listFormat.format(map(({ listing }: EmailEntry) => listing.name)(entries));
