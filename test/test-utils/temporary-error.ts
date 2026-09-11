import { expect } from "@std/expect";
import { expectHtml } from "#test-utils/assertions.ts";

const automaticMessages = [
  'http-equiv="refresh" content="2"',
  "Retrying automatically",
];
const manualMessages = [
  "Your changes may already be saved.",
  "Check the existing records or your booking before you submit again.",
];

export const expectTemporaryError =
  (autoRefresh: boolean): ((response: Response) => Promise<string>) =>
  (response: Response): Promise<string> => {
    expect(response.headers.get("refresh")).toBeNull();
    return expectHtml(response, {
      contains: [
        "Temporary error",
        ...(autoRefresh ? automaticMessages : manualMessages),
      ],
      notContains: autoRefresh
        ? manualMessages
        : [
            'http-equiv="refresh"',
            "Retrying automatically",
            "your submission was not saved",
          ],
      status: 503,
    });
  };
