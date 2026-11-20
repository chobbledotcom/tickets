/** The channels one person names, as an order writes them. */
export type Contact = { email: string; phone: string };

export type Source = "admin" | "public";

/** One stored ticket token and the source that booked it. */
export type Token = { source: Source; token: string };

/** A contact row and the tokens it must hold. */
export type ContactRead = readonly [contact: Contact, tokens: readonly Token[]];

/** A contact row and the exact blob it must store. */
export type ContactBlob = { blob: string; contact: Contact };

/** One contact row's booking counts. */
export type ContactCounts = { admin: number; contact: Contact; public: number };

export const emailOnly = (email: string): Contact => ({ email, phone: "" });

export const phoneOnly = (phone: string): Contact => ({ email: "", phone });

/** One order write, and what its contact rows then hold. */
export type OrderActivityCase = {
  bookings: readonly (readonly [Contact, Token])[];
  counts?: ContactCounts;
  /** Two contacts an order touches; each row gets its own marker. */
  markers?: readonly [Contact, Contact];
  name: string;
  reads?: readonly ContactRead[];
};

/* jscpd:ignore-start -- a table of cases, not code */
export const orderActivityCases: readonly OrderActivityCase[] = [
  {
    bookings: [
      [
        emailOnly("keyless@example.com"),
        { source: "public", token: "tok-keyless" },
      ],
    ],
    counts: { admin: 0, contact: emailOnly("keyless@example.com"), public: 1 },
    name: "order activity needs no owner key",
  },
  {
    bookings: [
      [
        emailOnly("tokens@example.com"),
        { source: "public", token: "tok-online" },
      ],
      [
        emailOnly("tokens@example.com"),
        { source: "admin", token: "tok-manual" },
      ],
    ],
    name: "order activity appends the booked token, tagged by source",
    reads: [
      [
        emailOnly("tokens@example.com"),
        [
          { source: "public", token: "tok-online" },
          { source: "admin", token: "tok-manual" },
        ],
      ],
    ],
  },
  {
    bookings: [
      [
        { email: "linked-token@example.com", phone: "07700 900111" },
        { source: "public", token: "tok-linked-contact" },
      ],
    ],
    markers: [emailOnly("linked-token@example.com"), phoneOnly("07700 900111")],
    name: "order activity does not reuse one marker across contact rows",
    reads: [
      [
        emailOnly("linked-token@example.com"),
        [{ source: "public", token: "tok-linked-contact" }],
      ],
      [
        phoneOnly("07700 900111"),
        [{ source: "public", token: "tok-linked-contact" }],
      ],
    ],
  },
];
/* jscpd:ignore-end */

/** One token sync: the seeded lines, the move, and what each row then holds. */
export type SyncCase = {
  blob?: ContactBlob;
  counts?: ContactCounts;
  from: Contact;
  hasBooking?: boolean;
  name: string;
  reads: readonly ContactRead[];
  /** Lines seeded on `from` before the sync. */
  seed?: readonly Token[];
  /** Start `from` with one line nothing can decrypt. */
  seedUnreadable?: boolean;
  to: Contact;
  token: string;
};

/* jscpd:ignore-start -- a table of cases, not code */
export const syncCases: readonly SyncCase[] = [
  {
    counts: { admin: 0, contact: emailOnly("readd@example.com"), public: 1 },
    from: emailOnly("readd@example.com"),
    name: "syncAttendeeContactTokens appends without bumping counts",
    reads: [
      [
        emailOnly("readd@example.com"),
        [
          { source: "public", token: "tok-first" },
          { source: "admin", token: "tok-moved" },
        ],
      ],
    ],
    seed: [{ source: "public", token: "tok-first" }],
    to: emailOnly("readd@example.com"),
    token: "tok-moved",
  },
  {
    from: emailOnly("old@example.com"),
    name: "syncAttendeeContactTokens re-homes a changed email, keeping source",
    reads: [
      [emailOnly("old@example.com"), []],
      [emailOnly("new@example.com"), [{ source: "admin", token: "tok-move" }]],
    ],
    seed: [{ source: "admin", token: "tok-move" }],
    to: emailOnly("new@example.com"),
    token: "tok-move",
  },
  {
    blob: {
      blob: "not-an-owner-key-token\n",
      contact: emailOnly("marker-old@example.com"),
    },
    from: emailOnly("marker-old@example.com"),
    name: "syncAttendeeContactTokens removes a moved token without decrypting unrelated lines",
    reads: [
      [
        emailOnly("marker-new@example.com"),
        [{ source: "public", token: "tok-marker-move" }],
      ],
    ],
    seed: [{ source: "public", token: "tok-marker-move" }],
    seedUnreadable: true,
    to: emailOnly("marker-new@example.com"),
    token: "tok-marker-move",
  },
  {
    from: phoneOnly("07700 900001"),
    name: "syncAttendeeContactTokens moves a changed phone too",
    reads: [
      [phoneOnly("07700 900001"), []],
      [phoneOnly("07700 900002"), [{ source: "public", token: "tok-phone" }]],
    ],
    seed: [{ source: "public", token: "tok-phone" }],
    to: phoneOnly("07700 900002"),
    token: "tok-phone",
  },
  {
    from: emailOnly("same@example.com"),
    name: "syncAttendeeContactTokens does not duplicate an unchanged token",
    reads: [
      [
        emailOnly("same@example.com"),
        [{ source: "public", token: "tok-same" }],
      ],
    ],
    seed: [{ source: "public", token: "tok-same" }],
    to: emailOnly("same@example.com"),
    token: "tok-same",
  },
  // Re-syncing a token whose contact did not change must keep it in place,
  // not remove and re-append it to the end.
  {
    from: emailOnly("order@example.com"),
    name: "syncAttendeeContactTokens does not reorder history on an unchanged edit",
    reads: [
      [
        emailOnly("order@example.com"),
        [
          { source: "public", token: "tok-first" },
          { source: "admin", token: "tok-second" },
        ],
      ],
    ],
    seed: [
      { source: "public", token: "tok-first" },
      { source: "admin", token: "tok-second" },
    ],
    to: emailOnly("order@example.com"),
    token: "tok-first",
  },
  {
    blob: { blob: "", contact: emailOnly("cleared@example.com") },
    from: emailOnly("cleared@example.com"),
    name: "syncAttendeeContactTokens drops the link when a field is cleared",
    reads: [[emailOnly("cleared@example.com"), []]],
    seed: [{ source: "admin", token: "tok-clear" }],
    to: { email: "", phone: "" },
    token: "tok-clear",
  },
  {
    from: { email: "", phone: "" },
    name: "syncAttendeeContactTokens links a newly added contact field",
    reads: [
      [
        emailOnly("fresh@example.com"),
        [{ source: "admin", token: "tok-fresh" }],
      ],
    ],
    to: emailOnly("fresh@example.com"),
    token: "tok-fresh",
  },
  {
    from: phoneOnly("07700 900123"),
    name: "syncAttendeeContactTokens gives an added field the booking's stored source",
    reads: [
      [
        emailOnly("added@example.com"),
        [{ source: "public", token: "tok-added" }],
      ],
    ],
    seed: [{ source: "public", token: "tok-added" }],
    to: { email: "added@example.com", phone: "07700 900123" },
    token: "tok-added",
  },
  {
    from: emailOnly("legacy-old@example.com"),
    name: "syncAttendeeContactTokens links a legacy moved contact with no old token",
    reads: [
      [
        emailOnly("legacy-fresh@example.com"),
        [{ source: "admin", token: "tok-legacy" }],
      ],
    ],
    to: emailOnly("legacy-fresh@example.com"),
    token: "tok-legacy",
  },
  {
    from: { email: "", phone: "" },
    hasBooking: false,
    name: "syncAttendeeContactTokens does not link a no-real-line attendee",
    reads: [[emailOnly("empty@example.com"), []]],
    to: emailOnly("empty@example.com"),
    token: "tok-empty",
  },
  {
    from: emailOnly("race-old@example.com"),
    name: "syncAttendeeContactTokens keeps a concurrent append while moving a token",
    reads: [
      [
        emailOnly("race-old@example.com"),
        [{ source: "admin", token: "tok-stay" }],
      ],
      [
        emailOnly("race-new@example.com"),
        [{ source: "public", token: "tok-move" }],
      ],
    ],
    seed: [
      { source: "public", token: "tok-move" },
      { source: "admin", token: "tok-stay" },
    ],
    to: emailOnly("race-new@example.com"),
    token: "tok-move",
  },
  {
    blob: { blob: "", contact: emailOnly("blank-line@example.com") },
    from: emailOnly("blank-line@example.com"),
    name: "removing the last moved token leaves an empty blob, not a stale newline",
    reads: [[emailOnly("blank-line@example.com"), []]],
    seed: [{ source: "public", token: "tok-only" }],
    to: { email: "", phone: "" },
    token: "tok-only",
  },
];
/* jscpd:ignore-end */
