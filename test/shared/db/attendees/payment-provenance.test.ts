import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { attendeePaymentProvenance } from "#db/attendees/payment-provenance.ts";
import { emptyResultSet } from "#test-utils/db-helpers/result-set.ts";

describe("attendeePaymentProvenance", () => {
  test("binds its session once", () => {
    const statement = attendeePaymentProvenance.statement("paid-session");

    expect(statement.args).toEqual(["paid-session"]);
    expect(statement.sql.match(/\?1/gu)).toHaveLength(2);
  });

  test("accepts exactly one recorded attendee", () => {
    attendeePaymentProvenance.require(
      { ...emptyResultSet(), rowsAffected: 1 },
      "paid-session",
    );
  });

  test("refuses any other affected-row count", () => {
    expect(() =>
      attendeePaymentProvenance.require(emptyResultSet(), "paid-session"),
    ).toThrow(
      "Payment session paid-session could not prove its attendee payment id",
    );
  });
});
