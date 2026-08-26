import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  mapProviderReader,
  type ProviderRead,
  type ProviderReader,
} from "#payment/provider-read.ts";

type Ticket = { seats: number };

/** A reader that always answers `read`, and remembers what it was asked. */
const readerOf = (
  read: ProviderRead<Ticket>,
): ProviderReader<Ticket> & { asked: string[] } => {
  const asked: string[] = [];
  const reader = (reference: string): Promise<ProviderRead<Ticket>> => {
    asked.push(reference);
    return Promise.resolve(read);
  };
  return Object.assign(reader, { asked });
};

/** Turn a found ticket into the seat count it names. */
const seatsOf = (ticket: Ticket): ProviderRead<number> => ({
  resource: ticket.seats,
  status: "found",
});

describe("mapping one provider reader onto a shared shape", () => {
  test("hands a found resource to the mapping", async () => {
    const source = readerOf({ resource: { seats: 4 }, status: "found" });
    expect(await mapProviderReader(source, seatsOf)("ref_1")).toEqual({
      resource: 4,
      status: "found",
    });
  });

  test("asks the source for the reference it was given, once per call", async () => {
    const source = readerOf({ resource: { seats: 4 }, status: "found" });
    const read = mapProviderReader(source, seatsOf);
    await read("ref_1");
    await read("ref_2");
    expect(source.asked).toEqual(["ref_1", "ref_2"]);
  });

  // A mapping that cannot see a resource must never run: the reason the
  // provider gave is the whole answer, and inventing one hides an outage.
  for (const read of [
    { status: "missing" },
    { reason: "rate_limited", status: "unavailable" },
    { reason: "mismatched_id", status: "invalid" },
  ] as const satisfies ProviderRead<Ticket>[]) {
    test(`passes on a read that is ${read.status} without mapping it`, async () => {
      const mapped = await mapProviderReader(readerOf(read), () => {
        throw new Error("the mapping read a resource that is not there");
      })("ref_1");
      expect(mapped).toEqual(read);
    });
  }
});
