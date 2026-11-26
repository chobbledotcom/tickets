import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { wordingOf } from "#shared/scanner-words.ts";
import type { ScanAnswer } from "#src/ui/client/scan-answer.ts";
import {
  CAMERA_ASKS,
  type Dialogs,
  type Given,
  PICK_ASKS,
  settleScan,
} from "#src/ui/client/scan-asks.ts";
import { PAGE_WORDS } from "#test/ui/client/scanner/words.ts";

const WRONG_LISTING: ScanAnswer = {
  listingName: "Tour",
  name: "Ada",
  status: "wrong_listing",
};

const CHECKED_IN: ScanAnswer = {
  listingName: "Ceilidh",
  name: "Ada",
  quantity: 2,
  remaining: 0,
  status: "checked_in",
  total: 2,
};

/** Settle one scan whose door answers `answers` in turn, with the door's
 * confirm answering `confirmed`. Answers what the scan sent, what the
 * dialogs were asked, what the door heard, and how the scan settled. */
const settleWith = async (
  asks: Parameters<typeof settleScan>[1],
  answers: ScanAnswer[],
  confirmed: boolean,
) => {
  const sent: Given[] = [];
  const asked: string[] = [];
  const said: [string, string][] = [];
  const dialogs: Dialogs = {
    confirm: (text) => {
      asked.push(text);
      return Promise.resolve(confirmed);
    },
    quantity: (_max, text) => {
      asked.push(text);
      return Promise.resolve(null);
    },
  };
  const settled = await settleScan(
    (given) => {
      sent.push(given);
      return Promise.resolve(answers[sent.length - 1]!);
    },
    asks,
    {
      dialogs,
      say: (text, type) => said.push([text, type]),
      wording: wordingOf(PAGE_WORDS),
    },
  );
  return { asked, said, sent, settled };
};

describe("the asks one scan raises", () => {
  const CONFIRM_WORDS =
    'Ada is registered for "Tour", not this listing. Check in anyway?';

  test("widens a camera scan to the other listing once the door says yes", async () => {
    const { asked, said, sent, settled } = await settleWith(
      CAMERA_ASKS,
      [WRONG_LISTING, CHECKED_IN],
      true,
    );

    expect(asked).toEqual([CONFIRM_WORDS]);
    expect(sent).toEqual([{}, { force: true }]);
    expect(settled).toEqual({ answer: CHECKED_IN, declined: false });
    expect(said).toEqual([]);
  });

  test("skips the person when the door says no", async () => {
    const { asked, said, sent, settled } = await settleWith(
      CAMERA_ASKS,
      [WRONG_LISTING],
      false,
    );

    expect(asked).toEqual([CONFIRM_WORDS]);
    expect(sent).toEqual([{}]);
    expect(settled).toEqual({ answer: WRONG_LISTING, declined: true });
    expect(said).toEqual([["Skipped Ada", "warning"]]);
  });

  test("never asks a pick to widen the door", async () => {
    const { asked, sent, settled } = await settleWith(
      PICK_ASKS,
      [WRONG_LISTING],
      true,
    );

    expect(asked).toEqual([]);
    expect(sent).toEqual([{}]);
    expect(settled).toEqual({ answer: WRONG_LISTING, declined: false });
  });
});
