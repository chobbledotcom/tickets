import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  eventsTable,
  getEventWithCount,
  invalidateEventsCache,
} from "#lib/db/events.ts";
import { handleRequest } from "#routes";
import { bodyToCreateInput, bodyToUpdateInput } from "#routes/admin/api.ts";
import {
  apiRequest,
  createTestApiKeyToken,
  createTestEvent,
  createTestGroup,
  describeWithEnv,
  expectJsonResponse,
  mockRequest,
  testCookie,
  testCsrfToken,
  testEventWithCount,
} from "#test-utils";

describeWithEnv("Admin API - Events", { db: true }, () => {
  describe("GET /api/admin/events/:eventId", () => {
    test("returns single event by ID", async () => {
      const event = await createTestEvent({ name: "Detail Event" });
      const apiKey = await createTestApiKeyToken();

      await apiRequest(`/api/admin/events/${event.id}`, {
        apiKey,
      }).then(expectJsonResponse(200, (body) => {
        expect(body.event.name).toBe("Detail Event");
        expect(body.event.id).toBe(event.id);
        expect(body.event.slug_index).toBeUndefined();
      }));
    });

    test("returns 404 for non-existent event", async () => {
      await apiRequest("/api/admin/events/99999").then(
        expectJsonResponse(404, (body) => {
          expect(body.message).toBe("Event not found");
        }),
      );
    });

    test("returns 401 without auth", async () => {
      const response = await handleRequest(mockRequest("/api/admin/events/1"));

      expect(response.status).toBe(401);
    });

    test("works with cookie+CSRF auth", async () => {
      const event = await createTestEvent({ name: "Cookie Detail" });
      const cookie = await testCookie();
      const csrfToken = await testCsrfToken();

      const response = await handleRequest(
        mockRequest(`/api/admin/events/${event.id}`, {
          headers: { cookie, "x-csrf-token": csrfToken },
        }),
      );

      await expectJsonResponse(200, (body) => {
        expect(body.event.name).toBe("Cookie Detail");
      })(response);
    });
  });

  describe("POST /api/admin/events", () => {
    test("creates event with required fields", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "New API Event",
          max_attendees: 50,
        },
      }).then(
        expectJsonResponse(201, (body) => {
          expect(body.event.name).toBe("New API Event");
          expect(body.event.max_attendees).toBe(50);
          expect(body.event.id).toBeGreaterThan(0);
          expect(body.event.slug_index).toBeUndefined();
        }),
      );
    });

    test("creates event with all optional fields", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Full Event",
          max_attendees: 100,
          description: "A test event",
          location: "Test Hall",
          unit_price: 500,
          max_quantity: 5,
          max_price: 1000,
          fields: "email,phone",
          event_type: "standard",
          non_transferable: true,
          can_pay_more: true,
          hidden: false,
          thank_you_url: "https://example.com/thanks",
          webhook_url: "https://example.com/webhook",
          minimum_days_before: 2,
          maximum_days_after: 60,
          bookable_days: ["Monday", "Tuesday"],
        },
      }).then(
        expectJsonResponse(201, (body) => {
          expect(body.event.name).toBe("Full Event");
          expect(body.event.description).toBe("A test event");
          expect(body.event.location).toBe("Test Hall");
          expect(body.event.unit_price).toBe(500);
          expect(body.event.max_quantity).toBe(5);
          expect(body.event.max_price).toBe(1000);
          expect(body.event.non_transferable).toBe(true);
          expect(body.event.can_pay_more).toBe(true);
          expect(body.event.hidden).toBe(false);
        }),
      );
    });

    test("returns 400 when name is missing", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: { max_attendees: 50 },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("name is required");
        }),
      );
    });

    test("returns 400 when max_attendees is missing", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: { name: "No Max" },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("max_attendees is required and must be >= 1");
        }),
      );
    });

    test("returns 400 when max_attendees is zero", async () => {
      const response = await apiRequest("/api/admin/events", {
        method: "POST",
        body: { name: "Zero Max", max_attendees: 0 },
      });

      expect(response.status).toBe(400);
    });

    test("validates can_pay_more requires sufficient max_price", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Pay More Event",
          max_attendees: 10,
          unit_price: 500,
          can_pay_more: true,
          max_price: 500,
        },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toContain("Maximum price");
        }),
      );
    });

    test("validates group exists", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Group Event",
          max_attendees: 10,
          group_id: 99999,
        },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("Selected group does not exist");
        }),
      );
    });
  });

  describe("PUT /api/admin/events/:eventId", () => {
    test("updates event name", async () => {
      const event = await createTestEvent({ name: "Original" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { name: "Updated Name" },
      }).then(
        expectJsonResponse(200, (body) => {
          expect(body.event.name).toBe("Updated Name");
          expect(body.event.id).toBe(event.id);
        }),
      );
    });

    test("updates event with partial fields", async () => {
      const event = await createTestEvent({
        name: "Partial Update",
        maxAttendees: 50,
      });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { max_attendees: 100, description: "Updated desc" },
      }).then(
        expectJsonResponse(200, (body) => {
          expect(body.event.name).toBe("Partial Update");
          expect(body.event.max_attendees).toBe(100);
          expect(body.event.description).toBe("Updated desc");
        }),
      );
    });

    test("returns 404 for non-existent event", async () => {
      const response = await apiRequest("/api/admin/events/99999", {
        method: "PUT",
        body: { name: "Ghost" },
      });

      expect(response.status).toBe(404);
    });

    test("returns 400 when name is empty string", async () => {
      const event = await createTestEvent({ name: "Will Empty" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { name: "" },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("name cannot be empty");
        }),
      );
    });

    test("rejects duplicate slug", async () => {
      const event1 = await createTestEvent({ name: "Event One" });
      const event2 = await createTestEvent({ name: "Event Two" });

      // Use event1's slug for event2
      await apiRequest(`/api/admin/events/${event2.id}`, {
        method: "PUT",
        body: { slug: event1.slug },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("Slug is already in use by another event");
        }),
      );
    });

    test("allows keeping the same slug", async () => {
      const event = await createTestEvent({ name: "Keep Slug" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { slug: event.slug, name: "Renamed" },
      }).then(
        expectJsonResponse(200, (body) => {
          expect(body.event.name).toBe("Renamed");
        }),
      );
    });
  });

  describe("DELETE /api/admin/events/:eventId", () => {
    test("deletes event with matching confirm_name", async () => {
      const event = await createTestEvent({ name: "Delete Me" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "DELETE",
        body: { confirm_name: "Delete Me" },
      }).then(
        expectJsonResponse(200, (body) => {
          expect(body.status).toBe("ok");
        }),
      );

      // Verify event is gone
      invalidateEventsCache();
      const deleted = await getEventWithCount(event.id);
      expect(deleted).toBeNull();
    });

    test("rejects with wrong confirm_name", async () => {
      const event = await createTestEvent({ name: "Protect Me" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "DELETE",
        body: { confirm_name: "Wrong Name" },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toContain("Event name does not match");
        }),
      );
    });

    test("rejects without confirm_name", async () => {
      const event = await createTestEvent({ name: "Need Confirm" });

      const response = await apiRequest(`/api/admin/events/${event.id}`, {
        method: "DELETE",
        body: {},
      });

      expect(response.status).toBe(400);
    });

    test("confirm_name is case-insensitive", async () => {
      const event = await createTestEvent({ name: "Case Test" });

      const response = await apiRequest(`/api/admin/events/${event.id}`, {
        method: "DELETE",
        body: { confirm_name: "case test" },
      });

      expect(response.status).toBe(200);
    });

    test("returns 404 for non-existent event", async () => {
      const response = await apiRequest("/api/admin/events/99999", {
        method: "DELETE",
        body: { confirm_name: "Ghost" },
      });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/admin/events/:eventId/deactivate", () => {
    test("deactivates an active event", async () => {
      const event = await createTestEvent({ name: "Active Event" });

      await apiRequest(
        `/api/admin/events/${event.id}/deactivate`,
        { method: "POST" },
      ).then(
        expectJsonResponse(200, (body) => {
          expect(body.event.active).toBe(false);
          expect(body.event.name).toBe("Active Event");
        }),
      );
    });

    test("returns 400 when event is already deactivated", async () => {
      const event = await createTestEvent({ name: "Inactive Event" });
      const apiKey = await createTestApiKeyToken();

      // Deactivate first
      await apiRequest(`/api/admin/events/${event.id}/deactivate`, {
        method: "POST",
        apiKey,
      });

      // Try to deactivate again
      await apiRequest(
        `/api/admin/events/${event.id}/deactivate`,
        { method: "POST", apiKey },
      ).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("Event is already deactivated");
        }),
      );
    });

    test("returns 404 for non-existent event", async () => {
      const response = await apiRequest("/api/admin/events/99999/deactivate", {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/admin/events/:eventId/reactivate", () => {
    test("reactivates a deactivated event", async () => {
      const event = await createTestEvent({ name: "Reactivate Event" });
      const apiKey = await createTestApiKeyToken();

      // Deactivate first
      await apiRequest(`/api/admin/events/${event.id}/deactivate`, {
        method: "POST",
        apiKey,
      });

      // Now reactivate
      await apiRequest(
        `/api/admin/events/${event.id}/reactivate`,
        { method: "POST", apiKey },
      ).then(
        expectJsonResponse(200, (body) => {
          expect(body.event.active).toBe(true);
          expect(body.event.name).toBe("Reactivate Event");
        }),
      );
    });

    test("returns 400 when event is already active", async () => {
      const event = await createTestEvent({ name: "Already Active" });

      await apiRequest(
        `/api/admin/events/${event.id}/reactivate`,
        { method: "POST" },
      ).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("Event is already active");
        }),
      );
    });

    test("returns 404 for non-existent event", async () => {
      const response = await apiRequest("/api/admin/events/99999/reactivate", {
        method: "POST",
      });

      expect(response.status).toBe(404);
    });
  });

  describe("POST /api/admin/events - date and closes_at handling", () => {
    test("creates event with date and closes_at", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Dated Event",
          max_attendees: 20,
          date: "2026-06-15T10:00:00Z",
          closes_at: "2026-06-14T23:59:00Z",
          active: true,
        },
      }).then(
        expectJsonResponse(201, (body) => {
          expect(body.event.date).toBe("2026-06-15T10:00:00.000Z");
          expect(body.event.closes_at).toBe("2026-06-14T23:59:00.000Z");
          expect(body.event.active).toBe(true);
        }),
      );
    });

    test("creates event with empty name string returns error", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: { name: "   ", max_attendees: 10 },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("name is required");
        }),
      );
    });
  });

  describe("PUT /api/admin/events/:eventId - comprehensive field updates", () => {
    test("updates all fields on an event", async () => {
      const event = await createTestEvent({ name: "Full Update" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: {
          name: "Fully Updated",
          max_attendees: 200,
          max_price: 5000,
          description: "New desc",
          date: "2026-12-25T18:00:00Z",
          location: "New Location",
          group_id: 0,
          unit_price: 1000,
          max_quantity: 10,
          thank_you_url: "https://new.example.com/thanks",
          webhook_url: "https://new.example.com/hook",
          active: true,
          fields: "email,phone,address",
          closes_at: "2026-12-24T23:59:00Z",
          event_type: "daily",
          bookable_days: ["Monday", "Wednesday", "Friday"],
          minimum_days_before: 3,
          maximum_days_after: 30,
          non_transferable: true,
          can_pay_more: true,
          hidden: true,
        },
      }).then(
        expectJsonResponse(200, (body) => {
          expect(body.event.name).toBe("Fully Updated");
          expect(body.event.max_attendees).toBe(200);
          expect(body.event.location).toBe("New Location");
          expect(body.event.unit_price).toBe(1000);
          expect(body.event.max_quantity).toBe(10);
          expect(body.event.event_type).toBe("daily");
          expect(body.event.bookable_days).toEqual([
            "Monday",
            "Wednesday",
            "Friday",
          ]);
          expect(body.event.minimum_days_before).toBe(3);
          expect(body.event.maximum_days_after).toBe(30);
          expect(body.event.non_transferable).toBe(true);
          expect(body.event.can_pay_more).toBe(true);
          expect(body.event.hidden).toBe(true);
        }),
      );
    });

    test("clears date by setting it to null", async () => {
      const event = await createTestEvent({ name: "Clear Date" });
      const apiKey = await createTestApiKeyToken();

      // First set a date
      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { date: "2026-06-15T10:00:00Z" },
        apiKey,
      });

      // Then clear it
      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { date: null },
        apiKey,
      }).then(
        expectJsonResponse(200, (body) => {
          expect(body.event.date).toBe("");
        }),
      );
    });

    test("clears closes_at by setting it to null", async () => {
      const event = await createTestEvent({ name: "Clear Closes" });
      const apiKey = await createTestApiKeyToken();

      // First set closes_at
      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { closes_at: "2026-06-14T23:59:00Z" },
        apiKey,
      });

      // Then clear it
      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { closes_at: null },
        apiKey,
      }).then(
        expectJsonResponse(200, (body) => {
          expect(body.event.closes_at).toBeNull();
        }),
      );
    });

    test("returns 400 for max_attendees less than 1", async () => {
      const event = await createTestEvent({ name: "Bad Max" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { max_attendees: 0 },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("max_attendees must be >= 1");
        }),
      );
    });

    test("validates can_pay_more max_price on update", async () => {
      const event = await createTestEvent({ name: "Pay More Update" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: {
          unit_price: 500,
          can_pay_more: true,
          max_price: 500,
        },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toContain("Maximum price");
        }),
      );
    });
  });

  describe("DELETE /api/admin/events/:eventId - with media", () => {
    test("deletes event with image_url and attachment_url", async () => {
      const event = await createTestEvent({ name: "Media Event" });
      // Set image_url and attachment_url directly
      await eventsTable.update(event.id, {
        imageUrl: "https://cdn.example.com/image.jpg",
        attachmentUrl: "https://cdn.example.com/file.pdf",
      });
      invalidateEventsCache();

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "DELETE",
        body: { confirm_name: "Media Event" },
      }).then(
        expectJsonResponse(200, (body) => {
          expect(body.status).toBe("ok");
        }),
      );
    });
  });

  describe("bodyToCreateInput", () => {
    test("returns error for non-string name", async () => {
      const result = await bodyToCreateInput({ name: 123, max_attendees: 10 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe("name is required");
    });

    test("returns error for missing max_attendees", async () => {
      const result = await bodyToCreateInput({ name: "Test" });
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toBe("max_attendees is required and must be >= 1");
    });

    test("handles all field types correctly", async () => {
      const result = await bodyToCreateInput({
        name: "Test",
        max_attendees: 10,
        date: "2026-06-15T10:00:00Z",
        closes_at: "2026-06-14T23:59:00Z",
        active: false,
        bookable_days: ["Monday"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.active).toBe(false);
        expect(result.input.bookableDays).toEqual(["Monday"]);
        expect(result.input.slug).toBeTruthy();
      }
    });
  });

  describe("POST /api/admin/events - group validation", () => {
    test("creates event in a valid group", async () => {
      const group = await createTestGroup({ name: "Valid Group" });

      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Grouped Event",
          max_attendees: 10,
          group_id: group.id,
          event_type: "standard",
        },
      }).then(
        expectJsonResponse(201, (body) => {
          expect(body.event.group_id).toBe(group.id);
        }),
      );
    });

    test("rejects event with mismatched type in group", async () => {
      const group = await createTestGroup({ name: "Type Group" });

      // Create a standard event in the group
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Standard In Group",
          max_attendees: 10,
          group_id: group.id,
          event_type: "standard",
        },
      });

      // Try to create a daily event in the same group
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Daily In Group",
          max_attendees: 10,
          group_id: group.id,
          event_type: "daily",
        },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toContain("same type");
        }),
      );
    });

    test("can_pay_more with valid max_price passes validation", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Pay More Valid",
          max_attendees: 10,
          unit_price: 500,
          can_pay_more: true,
          max_price: 700,
        },
      }).then(
        expectJsonResponse(201, (body) => {
          expect(body.event.can_pay_more).toBe(true);
        }),
      );
    });

    test("can_pay_more without unit_price passes validation", async () => {
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Free Pay More",
          max_attendees: 10,
          can_pay_more: true,
          max_price: 200,
        },
      }).then(
        expectJsonResponse(201, (body) => {
          expect(body.event.can_pay_more).toBe(true);
        }),
      );
    });
  });

  describe("PUT /api/admin/events/:eventId - validation errors", () => {
    test("rejects update with invalid group", async () => {
      const event = await createTestEvent({ name: "Update Group" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { group_id: 99999 },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toBe("Selected group does not exist");
        }),
      );
    });

    test("rejects update with mismatched group event type", async () => {
      const group = await createTestGroup({ name: "Update Type Group" });

      // Create a standard event in the group
      await apiRequest("/api/admin/events", {
        method: "POST",
        body: {
          name: "Standard First",
          max_attendees: 10,
          group_id: group.id,
          event_type: "standard",
        },
      });

      // Create a separate event and try to add it as daily to same group
      const event = await createTestEvent({ name: "Move To Group" });

      await apiRequest(`/api/admin/events/${event.id}`, {
        method: "PUT",
        body: { group_id: group.id, event_type: "daily" },
      }).then(
        expectJsonResponse(400, (body) => {
          expect(body.message).toContain("same type");
        }),
      );
    });
  });

  describe("bodyToUpdateInput", () => {
    test("preserves existing values when fields not provided", async () => {
      const existing = testEventWithCount({
        name: "Existing",
        slug: "existing-slug",
        description: "Existing desc",
        date: "2026-01-01T00:00:00.000Z",
        location: "Old Place",
        max_attendees: 50,
        unit_price: 100,
        max_quantity: 2,
        thank_you_url: "https://old.com/thanks",
        webhook_url: "https://old.com/hook",
        closes_at: "2026-01-02T00:00:00.000Z",
        bookable_days: ["Monday"],
        minimum_days_before: 1,
        maximum_days_after: 90,
      });

      const result = await bodyToUpdateInput({}, existing);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.name).toBe("Existing");
        expect(result.input.description).toBe("Existing desc");
        expect(result.input.location).toBe("Old Place");
        expect(result.input.unitPrice).toBe(100);
        expect(result.input.maxQuantity).toBe(2);
        expect(result.input.thankYouUrl).toBe("https://old.com/thanks");
        expect(result.input.webhookUrl).toBe("https://old.com/hook");
        expect(result.input.active).toBe(true);
        expect(result.input.fields).toBe("email");
        expect(result.input.closesAt).toBe("2026-01-02T00:00:00.000Z");
        expect(result.input.eventType).toBe("standard");
        expect(result.input.bookableDays).toEqual(["Monday"]);
        expect(result.input.minimumDaysBefore).toBe(1);
        expect(result.input.maximumDaysAfter).toBe(90);
        expect(result.input.nonTransferable).toBe(false);
        expect(result.input.canPayMore).toBe(false);
        expect(result.input.hidden).toBe(false);
        expect(result.input.maxPrice).toBe(0);
      }
    });

    test("preserves existing closes_at null as empty string", async () => {
      const existing = testEventWithCount({
        name: "No Closes",
        slug: "no-closes",
        max_attendees: 10,
        closes_at: null,
      });

      const result = await bodyToUpdateInput({}, existing);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.input.closesAt).toBe("");
      }
    });
  });
});
