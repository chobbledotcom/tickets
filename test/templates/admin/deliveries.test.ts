import { expect } from "@std/expect";
import { beforeAll, describe, it as test } from "@std/testing/bdd";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  agentDeliveriesPage,
  type DeliveryDayGroup,
  type DeliveryLegView,
} from "#templates/admin/deliveries.tsx";
import { setupTestEncryptionKey } from "#test-utils";

beforeAll(async () => {
  setupTestEncryptionKey();
  await signCsrfToken();
});

const leg = (over: Partial<DeliveryLegView> = {}): DeliveryLegView => ({
  address: "1 Test Street",
  agentName: "Van 1",
  attendeeId: 5,
  attendeeName: "Alice",
  done: false,
  kind: "start",
  listingId: 9,
  listingName: "Bouncy Castle",
  phone: "07700900000",
  time: "09:00",
  ...over,
});

describe("agentDeliveriesPage", () => {
  test("shows a prompt when no agents are assigned", () => {
    const html = agentDeliveriesPage([], "44", { noAgents: true });
    expect(html).toContain("no logistics agents assigned");
    expect(html).toContain("/admin/logout");
  });

  test("shows an empty message when every day is empty", () => {
    const groups: DeliveryDayGroup[] = [
      { heading: "Today", legs: [] },
      { heading: "Tomorrow", legs: [] },
    ];
    const html = agentDeliveriesPage(groups, "44", { noAgents: false });
    expect(html).toContain("No deliveries scheduled");
  });

  test("renders a drop-off leg with address, maps, phone and a done toggle", () => {
    const groups: DeliveryDayGroup[] = [
      { heading: "Today", legs: [leg()] },
      { heading: "Tomorrow", legs: [] },
    ];
    const html = agentDeliveriesPage(groups, "44", { noAgents: false });
    expect(html).toContain("Drop-off");
    expect(html).toContain("09:00");
    expect(html).toContain("Van 1");
    expect(html).toContain("Bouncy Castle");
    expect(html).toContain("Alice");
    expect(html).toContain("1 Test Street");
    expect(html).toContain("tel:+447700900000");
    expect(html).toContain("https://wa.me/447700900000");
    expect(html).toContain('action="/admin/deliveries/mark"');
    expect(html).toContain('value="start"');
    expect(html).toContain("Mark done");
    // The empty Tomorrow group shows its own placeholder.
    expect(html).toContain("Nothing scheduled");
  });

  test("renders a collection leg, a done leg, and tolerates missing fields", () => {
    const groups: DeliveryDayGroup[] = [
      {
        heading: "Today",
        legs: [
          leg({
            address: "",
            done: true,
            kind: "end",
            phone: "no-digits-here",
            time: "",
          }),
        ],
      },
      { heading: "Tomorrow", legs: [] },
    ];
    const html = agentDeliveriesPage(groups, "44", { noAgents: false });
    expect(html).toContain("Collection");
    expect(html).toContain("Mark not done");
    expect(html).toContain("delivery-leg done");
    // Non-callable phone is shown as plain text, with no tel: link.
    expect(html).toContain("no-digits-here");
    expect(html).not.toContain("tel:");
    // No address line when the address is blank.
    expect(html).not.toContain("1 Test Street");
  });

  test("omits the phone line entirely when there is no phone", () => {
    const groups: DeliveryDayGroup[] = [
      { heading: "Today", legs: [leg({ phone: "" })] },
      { heading: "Tomorrow", legs: [] },
    ];
    const html = agentDeliveriesPage(groups, "44", { noAgents: false });
    expect(html).not.toContain("delivery-phone");
  });

  test("renders flash messages", () => {
    const html = agentDeliveriesPage([], "44", {
      error: "Something went wrong",
      noAgents: true,
    });
    expect(html).toContain("Something went wrong");
  });
});
