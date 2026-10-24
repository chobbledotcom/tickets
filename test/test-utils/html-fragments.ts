import { expect } from "@std/expect";
import { escapeForRegex } from "#test-utils/regex.ts";

/** The one form control tag on a page with the given name — input, textarea,
 * or select — so a test can check the exact attributes a form serves
 * (default, bounds, required). */
export const inputNamed = (html: string, name: string): string => {
  // The lookahead keeps a longer tag like input-widget out, the whitespace
  // before name= keeps a longer attribute like data-name out, and escaping
  // keeps regex characters in a name literal.
  const tag = html.match(
    new RegExp(
      `<(?:input|textarea|select)(?=\\s)[^>]*\\sname="${escapeForRegex(name)}"[^>]*>`,
    ),
  )?.[0];
  if (!tag) throw new Error(`No control named ${name} on the page`);
  return tag;
};

/** Return the complete table row containing the given text. */
export const tableRowContaining = (html: string, text: string): string => {
  for (
    let start = html.indexOf("<tr");
    start >= 0;
    start = html.indexOf("<tr", start + 1)
  ) {
    const end = html.indexOf("</tr>", start);
    if (end === -1) break;
    const row = html.slice(start, end + 5);
    if (row.includes(text)) return row;
  }
  throw new Error(`No table row containing "${text}" found`);
};

// A booking's quantity cell only proves the bookings summary is right if it
// sits in the same table row as its listing link — otherwise swapping two
// bookings' quantities would still pass. The tempered `(?!</tr>)` keeps the
// match inside one <tr>.
export const expectListingRowQuantity = (
  html: string,
  listingId: number,
  quantity: number,
): void => {
  expect(html).toMatch(
    new RegExp(
      `/admin/listing/${listingId}"(?:(?!</tr>)[\\s\\S])*?<td class="col-quantity">${quantity}</td>`,
    ),
  );
};

export const matchGroup = (text: string, pattern: RegExp, group = 1): string =>
  text.match(pattern)![group]!;

/** Visible text labels of every `<option>` inside the `<select
 *  aria-label="…">` dropdown, in document order. Includes disabled and prompt
 *  options, so callers see exactly what the user sees — e.g. the "Select a
 *  date" clear option the date picker splices in between past and future
 *  dates. */
export const selectOptionLabels = (
  html: string,
  ariaLabel: string,
): (string | undefined)[] => {
  const inner = html.match(
    new RegExp(
      `<select[^>]*aria-label="${escapeForRegex(ariaLabel)}"[^>]*>([\\s\\S]*?)<\\/select>`,
    ),
  )![1]!;
  return [...inner.matchAll(/<option[^>]*>([^<]+)</g)].map((m) => m[1]);
};

/** The rendered attendee-editor line index for a listing's row (its FIRST
 * line, or the line on `packageGroupId`'s path), scraped from the form's
 * hidden `line_listing_<i>` / `line_package_<i>` inputs. Null when the
 * listing has no rendered line on that path. */
export const attendeeLineIndex = (
  html: string,
  listingId: number,
  packageGroupId = 0,
): string | null => {
  const listingFields = html.matchAll(
    /name="line_listing_(\d+)"[^>]*value="(\d+)"/g,
  );
  for (const match of listingFields) {
    if (Number(match[2]) !== listingId) continue;
    const index = match[1]!;
    const packageField = new RegExp(
      `name="line_package_${index}"[^>]*value="(\\d+)"`,
    ).exec(html);
    const lineGroup = packageField ? Number(packageField[1]) : 0;
    if (lineGroup === packageGroupId) return index;
  }
  return null;
};
