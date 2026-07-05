/**
 * Shared helpers for email templates
 */

import { map } from "#fp";
import type { EmailEntry } from "#shared/email.ts";

export type EmailContent = { subject: string; html: string; text: string };

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** Join display names the way email headings read ("A, B and C"). */
export const nameList = (names: string[]): string => listFormat.format(names);

export const listingNames = (entries: EmailEntry[]): string =>
  nameList(map(({ listing }: EmailEntry) => listing.name)(entries));
