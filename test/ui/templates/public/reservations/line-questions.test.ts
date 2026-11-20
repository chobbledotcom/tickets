import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { FormParams } from "#shared/form-data.ts";
import { setSavedFormData } from "#shared/forms/saved-data.ts";
import { MAX_TEXTAREA_LENGTH } from "#shared/limits.ts";
import {
  pageAnswerLines,
  renderLineQuestion,
} from "#templates/public/reservations/line-questions.tsx";
import { renderQuestions } from "#templates/public/reservations/questions.tsx";
import { expectIncludesAll } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { testQuestion } from "#test-utils/factories.ts";
import { withRequestContext } from "#test-utils/request-context.ts";
import { pageBookingTree, twoListingContext } from "#test-utils/ticket-ctx.ts";

const pupilName = testQuestion({
  answerLevel: "listing",
  displayType: "free_text",
  id: 4,
  text: "Pupil name",
});

const lines = [
  { id: 10, name: "Disco A" },
  { id: 20, name: "Disco B" },
];

describe("renderLineQuestion", () => {
  test("shows one text field under the question for each listing", () => {
    const html = renderLineQuestion(pupilName, lines).toString();
    expectIncludesAll(html, [
      "<legend>Pupil name</legend>",
      'name="question4_listing10"',
      'name="question4_listing20"',
      "Disco A",
      "Disco B",
      `maxlength="${MAX_TEXTAREA_LENGTH}"`,
    ]);
  });

  test("tags the group and each field with their listing ids for the visibility script", () => {
    const html = renderLineQuestion(pupilName, lines).toString();
    expectIncludesAll(html, [
      'data-listing-ids="10 20"',
      'data-listing-ids="10"',
      'data-listing-ids="20"',
    ]);
  });

  test("never marks a field required, because the script and the server hold that rule", () => {
    expect(renderLineQuestion(pupilName, lines).toString()).not.toContain(
      "required",
    );
  });

  test("restores each saved answer under its own listing", async () => {
    const html = await withRequestContext(() => {
      setSavedFormData(
        new FormParams({
          question4_listing10: "Ava",
          question4_listing20: "Ben",
        }),
      );
      return renderLineQuestion(pupilName, lines).toString();
    });
    expectIncludesAll(html, [
      'name="question4_listing10" type="text" value="Ava"',
      'name="question4_listing20" type="text" value="Ben"',
    ]);
  });
});

describe("renderQuestions with a listing-level question", () => {
  test("renders the question's fields for the booked listings it asks", () => {
    const html = renderQuestions(
      [pupilName],
      new Map([[4, [20]]]),
      lines,
    ).toString();
    expectIncludesAll(html, ['name="question4_listing20"', "Disco B"]);
    expect(html).not.toContain("question4_listing10");
  });

  test("renders a field for every listing when the question has no listing list", () => {
    const html = renderQuestions([pupilName], undefined, lines).toString();
    expectIncludesAll(html, [
      'name="question4_listing10"',
      'name="question4_listing20"',
    ]);
  });

  test("keeps a booking-level question as one field named for the question", () => {
    const html = renderQuestions(
      [{ ...pupilName, answerLevel: "booking" }],
      undefined,
      lines,
    ).toString();
    expectIncludesAll(html, ['name="question4"']);
    expect(html).not.toContain("question4_listing");
  });
});

describeWithEnv("pageAnswerLines", { db: true }, () => {
  test("names each shown listing of the page once", async () => {
    const { ctx, first, second } = await twoListingContext();
    expect(
      pageAnswerLines(ctx.listings, pageBookingTree(ctx), undefined),
    ).toEqual([
      { id: first.id, name: first.name },
      { id: second.id, name: second.name },
    ]);
  });

  test("adds the children a buyer can choose, once", async () => {
    const { ctx, first, second } = await twoListingContext();
    const secondInfo = ctx.listings.find(
      (info) => info.listing.id === second.id,
    )!;
    const children = new Map([[first.id, [secondInfo]]]);
    expect(
      pageAnswerLines(ctx.listings, pageBookingTree(ctx), children),
    ).toEqual([
      { id: first.id, name: first.name },
      { id: second.id, name: second.name },
    ]);
  });
});
