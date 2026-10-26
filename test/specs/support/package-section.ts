/**
 * The package section's slices of a served ticket page: the package's own
 * fieldset, and one member's row inside it. Both read the page's words only,
 * so the picture steps can prove where a picture shows.
 */

import { escapeHtml } from "#jsx/escape-html.ts";
import type { Group } from "#types";

/** The named package's own section on a served page: the fieldset the page
 * renders for it, where its description and each member's row show. A member
 * that is itself a parent renders its own nested fieldset, so the section
 * ends at its own fieldset's closing tag, never at the first closing tag. */
export const packageSectionHtml = (html: string, group: Group): string => {
  const start = html.indexOf(`data-package-section="${group.id}"`);
  if (start < 0) {
    throw new Error(`the page shows no section for the package ${group.name}`);
  }
  // The section's own fieldset opened before `start`, where its
  // data-package-section attribute sits.
  let openSections = 1;
  let at = start;
  while (openSections > 0) {
    const nextOpen = html.indexOf("<fieldset", at);
    const nextClose = html.indexOf("</fieldset>", at);
    if (nextClose < 0) {
      throw new Error(
        `the page leaves the package ${group.name}'s section open`,
      );
    }
    if (nextOpen >= 0 && nextOpen < nextClose) {
      openSections += 1;
      at = nextOpen + "<fieldset".length;
    } else {
      openSections -= 1;
      at = nextClose + "</fieldset>".length;
    }
  }
  return html.slice(start, at);
};

/** One member's row inside a package section: from the row's own opening tag
 * to the next row's, so a picture found in the slice shows in that row. The
 * row's label spells the name the way the page does, escaped. */
export const memberRowHtml = (section: string, memberName: string): string => {
  const label = `<label>${escapeHtml(memberName)} <span class="package-member-qty">`;
  const at = section.indexOf(label);
  if (at < 0) {
    throw new Error(`the package section shows no row for ${memberName}`);
  }
  const rowStart = section.lastIndexOf('<div class="ticket-row', at);
  if (rowStart < 0) {
    throw new Error(`the package section renders ${memberName} outside a row`);
  }
  const nextRow = section.indexOf('<div class="ticket-row', at + label.length);
  return section.slice(rowStart, nextRow < 0 ? section.length : nextRow);
};
