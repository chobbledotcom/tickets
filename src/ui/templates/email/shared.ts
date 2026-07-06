/**
 * Shared helpers for email templates
 */

export type EmailContent = { subject: string; html: string; text: string };

const listFormat = new Intl.ListFormat("en", { type: "conjunction" });

/** Join display names the way email headings read ("A, B and C"). */
export const nameList = (names: string[]): string => listFormat.format(names);
