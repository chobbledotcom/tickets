import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  type CsvListingInfo,
  generateAttendeesCsv,
} from "#routes/admin/attendees-csv.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  expectTestAttendeeCsvColumns,
  setupTestEncryptionKey,
  testAttendee,
} from "#test-utils";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

describe("generateAttendeesCsv", () => {
  test("generates CSV header for empty attendees", () => {
    const csv = generateAttendeesCsv([]);
    expect(csv).toBe(
      "Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
    );
  });

  test("generates CSV with attendee data", () => {
    const attendees = [
      testAttendee({ created: "2024-01-15T10:30:00Z", quantity: 2 }),
    ];
    const csv = generateAttendeesCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
    );
    expectTestAttendeeCsvColumns(lines[1], 2);
    expect(lines[1]).toContain("2024-01-15T10:30:00.000Z");
  });

  test("blanks the ticket URL for a no-quantity row but keeps the token", () => {
    const real = testAttendee({ quantity: 1, ticket_token: "real-tok" });
    const ghost = testAttendee({ quantity: 0, ticket_token: "ghost-tok" });
    const lines = generateAttendeesCsv([real, ghost]).split("\n");
    // Real row carries a live /t URL; the ghost row's URL column is empty.
    expect(lines[1]).toContain("/t/real-tok");
    expect(lines[2]).toContain("ghost-tok");
    expect(lines[2]).not.toContain("/t/ghost-tok");
    expect(lines[2]!.endsWith("ghost-tok,")).toBe(true);
  });

  test("escapes values with commas", () => {
    const attendees = [testAttendee({ name: "Doe, John" })];
    const csv = generateAttendeesCsv(attendees);
    expect(csv).toContain('"Doe, John"');
  });

  test("escapes values with quotes", () => {
    const attendees = [testAttendee({ name: 'John "JD" Doe' })];
    const csv = generateAttendeesCsv(attendees);
    expect(csv).toContain('"John ""JD"" Doe"');
  });

  test("escapes values with newlines", () => {
    const attendees = [testAttendee({ name: "John\nDoe" })];
    const csv = generateAttendeesCsv(attendees);
    expect(csv).toContain('"John\nDoe"');
  });

  test("generates multiple rows", () => {
    const attendees = [
      testAttendee(),
      testAttendee({
        created: "2024-01-16T11:00:00Z",
        email: "jane@example.com",
        id: 2,
        name: "Jane Smith",
        quantity: 3,
      }),
    ];
    const csv = generateAttendeesCsv(attendees);
    const lines = csv.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("John Doe");
    expect(lines[2]).toContain("Jane Smith");
  });

  test("includes phone number in CSV output", () => {
    const attendees = [testAttendee({ phone: "+1 555 123 4567" })];
    const csv = generateAttendeesCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("+1 555 123 4567");
  });

  test("includes empty phone column when phone not collected", () => {
    const attendees = [testAttendee()];
    const csv = generateAttendeesCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("john@example.com,,,,1,");
  });

  test("generates CSV with price and transaction ID", () => {
    const attendees = [
      testAttendee({
        payment_id: "pi_abc123",
        price_paid: "2000",
        quantity: 2,
      }),
    ];
    const csv = generateAttendeesCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("20.00");
    expect(lines[1]).toContain("pi_abc123");
  });

  test("formats zero price and empty payment_id for free attendees", () => {
    const attendees = [testAttendee()];
    const csv = generateAttendeesCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("0.00,,No,");
  });

  test("includes Checked In as Yes for checked-in attendee", () => {
    const attendees = [testAttendee({ checked_in: true })];
    const csv = generateAttendeesCsv(attendees);
    expect(csv.split("\n")[1]).toContain(",Yes,");
  });

  test("includes Checked In as No for not checked-in attendee", () => {
    const attendees = [testAttendee({ checked_in: false })];
    const csv = generateAttendeesCsv(attendees);
    expect(csv.split("\n")[1]).toContain(",No,");
  });

  test("includes ticket token and URL in CSV output", () => {
    const attendees = [testAttendee({ ticket_token: "abc123" })];
    const csv = generateAttendeesCsv(attendees);
    const lines = csv.split("\n");
    expect(lines[1]).toContain("abc123");
    expect(lines[1]).toContain("https://localhost/t/abc123");
  });

  test("includes Date column when includeDate is true", () => {
    const csv = generateAttendeesCsv([], true);
    expect(csv).toBe(
      "Date,Name,Email,Phone,Address,Special Instructions,Quantity,Registered,Price Paid,Transaction ID,Checked In,Ticket Token,Ticket URL",
    );
  });

  test("includes date value in row when includeDate is true", () => {
    const attendees = [testAttendee({ date: "2026-03-15" })];
    const csv = generateAttendeesCsv(attendees, true);
    const lines = csv.split("\n");
    expect(lines[0]).toContain("Date,Name");
    expect(lines[1]).toMatch(/^2026-03-15,/);
  });

  test("includes empty date in row when date is null", () => {
    const attendees = [testAttendee({ date: null })];
    const csv = generateAttendeesCsv(attendees, true);
    const lines = csv.split("\n");
    expect(lines[1]).toMatch(/^,John Doe/);
  });

  test("omits Date column when includeDate is false", () => {
    const attendees = [testAttendee({ date: "2026-03-15" })];
    const csv = generateAttendeesCsv(attendees, false);
    expect(csv.startsWith("Name,")).toBe(true);
    expect(csv).not.toContain("2026-03-15");
  });
});

describe("generateAttendeesCsv with listingInfo", () => {
  test("includes Listing Date column when listingInfo has non-empty listingDate", () => {
    const listingInfo: CsvListingInfo = {
      listingDate: "2026-06-15T14:00:00.000Z",
      listingLocation: "",
    };
    const csv = generateAttendeesCsv([], false, listingInfo);
    expect(csv).toContain("Listing Date,Name");
    expect(csv).not.toContain("Listing Location");
  });

  test("includes Listing Location column when listingInfo has non-empty listingLocation", () => {
    const listingInfo: CsvListingInfo = {
      listingDate: "",
      listingLocation: "Village Hall",
    };
    const csv = generateAttendeesCsv([], false, listingInfo);
    expect(csv).toContain("Listing Location,Name");
    expect(csv).not.toContain("Listing Date");
  });

  test("includes both Listing Date and Listing Location columns", () => {
    const listingInfo: CsvListingInfo = {
      listingDate: "2026-06-15T14:00:00.000Z",
      listingLocation: "Village Hall",
    };
    const csv = generateAttendeesCsv([], false, listingInfo);
    expect(csv).toContain("Listing Date,Listing Location,Name");
  });

  test("includes listing date and location values in rows", () => {
    const listingInfo: CsvListingInfo = {
      listingDate: "2026-06-15T14:00:00.000Z",
      listingLocation: "Village Hall",
    };
    const attendees = [testAttendee()];
    const csv = generateAttendeesCsv(attendees, false, listingInfo);
    const lines = csv.split("\n");
    // The UTC ISO listing datetime is shown as a date + time in the tz
    // (14:00 UTC = 15:00 BST in the default Europe/London timezone).
    expect(lines[1]).toContain("2026-06-15 15:00,Village Hall,John Doe");
  });

  test("renders the Listing Date (with time) in the given timezone", () => {
    const listingInfo: CsvListingInfo = {
      // 23:30 UTC is 00:30 the next day in BST (Europe/London).
      listingDate: "2026-06-15T23:30:00.000Z",
      listingLocation: "",
    };
    const attendees = [testAttendee()];
    const utc = generateAttendeesCsv(
      attendees,
      false,
      listingInfo,
      undefined,
      "UTC",
    );
    expect(utc.split("\n")[1]).toContain("2026-06-15 23:30");
    const bst = generateAttendeesCsv(
      attendees,
      false,
      listingInfo,
      undefined,
      "Europe/London",
    );
    expect(bst.split("\n")[1]).toContain("2026-06-16 00:30");
  });

  test("omits Listing Date and Listing Location when listingInfo is undefined", () => {
    const csv = generateAttendeesCsv([], false);
    expect(csv).not.toContain("Listing Date");
    expect(csv).not.toContain("Listing Location");
  });

  test("omits Listing Date and Listing Location when both are empty", () => {
    const listingInfo: CsvListingInfo = {
      listingDate: "",
      listingLocation: "",
    };
    const csv = generateAttendeesCsv([], false, listingInfo);
    expect(csv).not.toContain("Listing Date");
    expect(csv).not.toContain("Listing Location");
  });
});
