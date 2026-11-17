/**
 * Tests for `src/shared/db/attendees/reads.ts`.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeeIdOfToken, sealedContactsOf } from "#db/attendees/reads.ts";
import { matchesNothing } from "#db/select/expression.ts";
import { placed } from "#test-utils/sql-text.ts";

describe("attendeeIdOfToken", () => {
  test("reads the id under a word that an attendee read can hold", () => {
    expect(placed(attendeeIdOfToken("index"))).toEqual({
      args: ["index"],
      sql: "SELECT tokenHolder.id AS id FROM attendees AS tokenHolder WHERE tokenHolder.ticket_token_index = ?",
    });
  });
});

describe("sealedContactsOf", () => {
  test("reads the id and the sealed details of the named attendees", () => {
    expect(placed(sealedContactsOf([4, 9]))).toEqual({
      args: [4, 9],
      sql: "SELECT attendee.id AS id, attendee.pii_blob AS piiBlob FROM attendees AS attendee WHERE attendee.id IN (?, ?)",
    });
  });

  test("is a read that no row can pass when it names no attendee", () => {
    expect(matchesNothing(sealedContactsOf([]))).toBe(true);
  });
});
