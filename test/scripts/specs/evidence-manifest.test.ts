import {
  AttachmentContentEncoding,
  type Envelope,
  type Pickle,
} from "@cucumber/messages";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import sharp from "sharp";
import {
  buildEvidenceBundle,
  writeEvidenceBundle,
} from "#scripts/specs/evidence/manifest.ts";
import {
  EVIDENCE_REPOSITORY,
  parseEvidenceDeclarations,
} from "#scripts/specs/evidence/schema.ts";
import { requireValue } from "#shared/required-value.ts";
import {
  outlineFeature,
  validFeature,
} from "#test/scripts/specs/profile-fixture.ts";
import {
  compileEvidenceFeature,
  PLAIN_EVIDENCE_SCENARIO,
} from "./evidence-fixture.ts";

const timestamp = { nanos: 0, seconds: 0 };

const evidenceMessages = (
  document: NonNullable<Envelope["gherkinDocument"]>,
  pickle: Pickle,
  filenames: string[],
  png: Uint8Array,
): Envelope[] => [
  { gherkinDocument: document },
  { pickle },
  {
    testCase: { id: "test-case", pickleId: pickle.id, testSteps: [] },
  },
  {
    testCaseStarted: {
      attempt: 0,
      id: "started-case",
      testCaseId: "test-case",
      timestamp,
    },
  },
  ...filenames.map(
    (fileName): Envelope => ({
      attachment: {
        body: png.toBase64(),
        contentEncoding: AttachmentContentEncoding.BASE64,
        fileName,
        mediaType: "image/png",
        testCaseStartedId: "started-case",
        testStepId: "after-hook",
      },
    }),
  ),
];

const declaration = {
  caseId: "payment.place-available",
  element: "#payment-result",
  id: "payment-result",
  path: "/admin/payments/{paymentId}",
  presentation: "canonical",
  profiles: ["mobile"],
} as const;

const plainBundleInput = async (
  filenames = ["payment-result--mobile.png"],
  image?: Uint8Array,
): Promise<Parameters<typeof buildEvidenceBundle>[0]> => {
  const fixture = compileEvidenceFeature(validFeature);
  const png =
    image ??
    (await sharp({
      create: { background: "black", channels: 3, height: 1, width: 1 },
    })
      .png()
      .toBuffer());
  return {
    catalog: fixture.catalog,
    commit: "a".repeat(40),
    declarations: parseEvidenceDeclarations([declaration], fixture.catalog),
    messages: evidenceMessages(
      fixture.document,
      requireValue(fixture.pickles[0], "Plain Pickle is missing"),
      filenames,
      png,
    ),
  };
};

const updateAttachments = (
  messages: readonly Envelope[],
  update: (
    attachment: NonNullable<Envelope["attachment"]>,
  ) => NonNullable<Envelope["attachment"]>,
): Envelope[] =>
  messages.map((message) =>
    message.attachment ? { attachment: update(message.attachment) } : message,
  );

const buildOutlineBundle = async () => {
  const fixture = compileEvidenceFeature(outlineFeature);
  const declarationForRow = {
    ...declaration,
    caseId: "payment.two-left",
    id: "outline-result",
  };
  const png = await sharp({
    create: { background: "white", channels: 3, height: 1, width: 1 },
  })
    .png()
    .toBuffer();
  return buildEvidenceBundle({
    catalog: fixture.catalog,
    commit: "a".repeat(40),
    declarations: parseEvidenceDeclarations(
      [declarationForRow],
      fixture.catalog,
    ),
    messages: evidenceMessages(
      fixture.document,
      requireValue(fixture.pickles[1], "Second Outline Pickle is missing"),
      ["outline-result--mobile.png"],
      png,
    ),
  });
};

describe("Cucumber evidence manifest", () => {
  test("builds the same compact manifest and assets for any message order", async () => {
    const fixture = compileEvidenceFeature(validFeature);
    const declarations = parseEvidenceDeclarations(
      [declaration],
      fixture.catalog,
    );
    const png = await sharp({
      create: {
        background: "#123456",
        channels: 3,
        height: 3,
        width: 2,
      },
    })
      .png()
      .toBuffer();
    const messages = evidenceMessages(
      fixture.document,
      requireValue(fixture.pickles[0], "Plain Pickle is missing"),
      ["payment-result--mobile.png"],
      png,
    );

    const first = await buildEvidenceBundle({
      catalog: fixture.catalog,
      commit: "a".repeat(40),
      declarations,
      messages,
    });
    const second = await buildEvidenceBundle({
      catalog: fixture.catalog,
      commit: "a".repeat(40),
      declarations,
      messages: [...messages].reverse(),
    });

    expect(JSON.stringify(first.manifest)).toBe(
      JSON.stringify(second.manifest),
    );
    expect(first.assets).toEqual(second.assets);
    expect(first.manifest).toEqual({
      app: {
        commit: "a".repeat(40),
        repository: EVIDENCE_REPOSITORY,
      },
      captures: [
        {
          assets: [
            {
              height: 3,
              mediaType: "image/png",
              path: "assets/payment-result--mobile.png",
              profile: "mobile",
              sha256:
                "e4877bdee1634553b5a8a0160f8afddbc5e97eb203bda25ac97a191f82886a02",
              viewport: {
                deviceScaleFactor: 2,
                height: 844,
                width: 390,
              },
              width: 2,
            },
          ],
          ...PLAIN_EVIDENCE_SCENARIO,
          id: "payment-result",
          presentation: "canonical",
        },
      ],
      schemaVersion: 1,
    });
    expect(JSON.stringify(first.manifest)).not.toMatch(
      /started-case|test-case|timestamp/,
    );
  });

  test("fails for missing duplicate and unexpected attachments", async () => {
    const fixture = compileEvidenceFeature(validFeature);
    const declarations = parseEvidenceDeclarations(
      [declaration],
      fixture.catalog,
    );
    const png = await sharp({
      create: { background: "black", channels: 3, height: 1, width: 1 },
    })
      .png()
      .toBuffer();
    const build = (filenames: string[]) =>
      buildEvidenceBundle({
        catalog: fixture.catalog,
        commit: "a".repeat(40),
        declarations,
        messages: evidenceMessages(
          fixture.document,
          requireValue(fixture.pickles[0], "Plain Pickle is missing"),
          filenames,
          png,
        ),
      });

    await expect(build([])).rejects.toThrow(
      "Missing evidence attachment payment-result--mobile.png",
    );
    await expect(
      build(["payment-result--mobile.png", "payment-result--mobile.png"]),
    ).rejects.toThrow(
      "Duplicate evidence attachment payment-result--mobile.png",
    );
    await expect(build(["unexpected.png"])).rejects.toThrow(
      "Unexpected evidence attachment unexpected.png",
    );
  });

  test("links an Outline attachment to its row case_id", async () => {
    const bundle = await buildOutlineBundle();

    expect(bundle.manifest.captures[0]?.case).toEqual({
      id: "payment.two-left",
      name: "Payment result payment.two-left",
    });
  });

  test("rejects malformed attachment links and image data", async () => {
    const input = await plainBundleInput();
    const withoutAttachmentField = (
      field: "fileName" | "testCaseStartedId",
    ): Envelope[] =>
      updateAttachments(input.messages, (attachment) => {
        const { [field]: _removed, ...remaining } = attachment;
        return remaining;
      });
    const failures: [readonly Envelope[], string][] = [
      [
        input.messages.filter((message) => !message.testCase),
        "No Pickle for Cucumber test case test-case",
      ],
      [
        updateAttachments(input.messages, (attachment) => ({
          ...attachment,
          contentEncoding: AttachmentContentEncoding.IDENTITY,
        })),
        "Evidence PNG attachment is not base64 encoded",
      ],
      [
        withoutAttachmentField("testCaseStartedId"),
        "Evidence attachment has no running case",
      ],
      [
        updateAttachments(input.messages, (attachment) => ({
          ...attachment,
          testCaseStartedId: "unknown-started-case",
        })),
        "No Cucumber scenario for attachment payment-result--mobile.png",
      ],
      [
        input.messages.filter((message) => !message.pickle),
        "No Cucumber scenario for attachment payment-result--mobile.png",
      ],
      [
        input.messages.filter((message) => !message.gherkinDocument),
        "No Gherkin document for specs/payments/capacity.feature",
      ],
      [
        withoutAttachmentField("fileName"),
        "Unexpected evidence attachment without filename",
      ],
      [
        updateAttachments(input.messages, (attachment) => ({
          ...attachment,
          mediaType: "text/plain",
        })),
        "Unexpected evidence attachment payment-result--mobile.png",
      ],
    ];

    for (const [messages, message] of failures) {
      await expect(buildEvidenceBundle({ ...input, messages })).rejects.toThrow(
        message,
      );
    }

    const jpeg = await sharp({
      create: { background: "black", channels: 3, height: 1, width: 1 },
    })
      .jpeg()
      .toBuffer();
    await expect(
      buildEvidenceBundle(await plainBundleInput(undefined, jpeg)),
    ).rejects.toThrow("Evidence attachment is not a sized PNG");
  });

  test("sorts captures by their stable capture id", async () => {
    const second = {
      ...declaration,
      id: "accounting-result",
      presentation: "editorial",
    } as const;
    const input = await plainBundleInput([
      "payment-result--mobile.png",
      "accounting-result--mobile.png",
    ]);
    const bundle = await buildEvidenceBundle({
      ...input,
      declarations: parseEvidenceDeclarations(
        [declaration, second],
        input.catalog,
      ),
    });

    expect(bundle.manifest.captures.map(({ id }) => id)).toEqual([
      "accounting-result",
      "payment-result",
    ]);
  });

  test("replaces stale output with only the public manifest and assets", async () => {
    const directory = await Deno.makeTempDir();
    const output = `${directory}/evidence`;
    await Deno.mkdir(output);
    await Deno.writeTextFile(`${output}/stale.ndjson`, "private");
    try {
      const bundle = await buildOutlineBundle();
      await writeEvidenceBundle(output, bundle);

      expect(
        [...(await Array.fromAsync(Deno.readDir(output)))]
          .map(({ name }) => name)
          .sort(),
      ).toEqual(["assets", "manifest.json"]);
      expect(
        await Deno.readFile(`${output}/assets/outline-result--mobile.png`),
      ).toEqual(bundle.assets.get("assets/outline-result--mobile.png"));
      expect(await Deno.readTextFile(`${output}/manifest.json`)).toBe(
        `${JSON.stringify(bundle.manifest, null, 2)}\n`,
      );
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });
});
