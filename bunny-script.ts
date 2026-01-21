// src/edge/bunny-script.ts
import * as BunnySDK from "https://esm.sh/@bunny.net/edgescript-sdk@0.10.0";

// src/lib/db.ts
import { createClient } from "https://esm.sh/@libsql/client@0.6.0/web";
var db = null;
var getDb = () => {
  if (!db) {
    const url = process.env.DB_URL || "file:tickets.db";
    db = createClient({
      url,
      authToken: process.env.DB_TOKEN
    });
  }
  return db;
};
var initDb = async () => {
  const client = getDb();
  await client.execute(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      max_attendees INTEGER NOT NULL,
      thank_you_url TEXT NOT NULL
    )
  `);
  await client.execute(`
    CREATE TABLE IF NOT EXISTS attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id)
    )
  `);
};
var getSetting = async (key) => {
  const result = await getDb().execute({
    sql: "SELECT value FROM settings WHERE key = ?",
    args: [key]
  });
  if (result.rows.length === 0)
    return null;
  return result.rows[0].value;
};
var verifyAdminPassword = async (password) => {
  const stored = await getSetting("admin_password");
  return stored === password;
};
var createEvent = async (name, description, maxAttendees, thankYouUrl) => {
  const created = new Date().toISOString();
  const result = await getDb().execute({
    sql: `INSERT INTO events (created, name, description, max_attendees, thank_you_url)
          VALUES (?, ?, ?, ?, ?)`,
    args: [created, name, description, maxAttendees, thankYouUrl]
  });
  return {
    id: Number(result.lastInsertRowid),
    created,
    name,
    description,
    max_attendees: maxAttendees,
    thank_you_url: thankYouUrl
  };
};
var getAllEvents = async () => {
  const result = await getDb().execute(`
    SELECT e.*, COUNT(a.id) as attendee_count
    FROM events e
    LEFT JOIN attendees a ON e.id = a.event_id
    GROUP BY e.id
    ORDER BY e.created DESC
  `);
  return result.rows;
};
var getEventWithCount = async (id) => {
  const result = await getDb().execute({
    sql: `SELECT e.*, COUNT(a.id) as attendee_count
          FROM events e
          LEFT JOIN attendees a ON e.id = a.event_id
          WHERE e.id = ?
          GROUP BY e.id`,
    args: [id]
  });
  if (result.rows.length === 0)
    return null;
  return result.rows[0];
};
var getAttendees = async (eventId) => {
  const result = await getDb().execute({
    sql: "SELECT * FROM attendees WHERE event_id = ? ORDER BY created DESC",
    args: [eventId]
  });
  return result.rows;
};
var createAttendee = async (eventId, name, email) => {
  const created = new Date().toISOString();
  const result = await getDb().execute({
    sql: "INSERT INTO attendees (event_id, name, email, created) VALUES (?, ?, ?, ?)",
    args: [eventId, name, email, created]
  });
  return {
    id: Number(result.lastInsertRowid),
    event_id: eventId,
    name,
    email,
    created
  };
};
var hasAvailableSpots = async (eventId) => {
  const event = await getEventWithCount(eventId);
  if (!event)
    return false;
  return event.attendee_count < event.max_attendees;
};

// src/fp/index.ts
var pipe = (...fns) => (value) => fns.reduce((acc, fn) => fn(acc), value);
var map = (fn) => (array) => array.map(fn);
var reduce = (fn, initial) => (array) => array.reduce(fn, initial);

// src/lib/html.ts
var escapeHtml = (str) => str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var baseStyles = `
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
  h1 { color: #333; }
  .form-group { margin-bottom: 1rem; }
  label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
  input, textarea { padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; width: 100%; box-sizing: border-box; }
  button { background: #0066cc; color: white; padding: 0.5rem 1.5rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; }
  button:hover { background: #0055aa; }
  .error { color: #cc0000; background: #ffeeee; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
  .success { color: #006600; background: #eeffee; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f5f5f5; }
  a { color: #0066cc; }
`;
var layout = (title, content) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${baseStyles}</style>
</head>
<body>
  ${content}
</body>
</html>`;
var adminLoginPage = (error) => layout("Admin Login", `
    <h1>Admin Login</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
      </div>
      <button type="submit">Login</button>
    </form>
  `);
var joinStrings = reduce((acc, s) => acc + s, "");
var renderEventRow = (e) => `
  <tr>
    <td>${escapeHtml(e.name)}</td>
    <td>${e.attendee_count} / ${e.max_attendees}</td>
    <td>${new Date(e.created).toLocaleDateString()}</td>
    <td><a href="/admin/event/${e.id}">View</a></td>
  </tr>
`;
var adminDashboardPage = (events) => {
  const eventRows = events.length > 0 ? pipe(map(renderEventRow), joinStrings)(events) : '<tr><td colspan="4">No events yet</td></tr>';
  return layout("Admin Dashboard", `
    <h1>Admin Dashboard</h1>
    <p><a href="/admin/logout">Logout</a></p>

    <h2>Events</h2>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Attendees</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${eventRows}
      </tbody>
    </table>

    <h2>Create New Event</h2>
    <form method="POST" action="/admin/event">
      <div class="form-group">
        <label for="name">Event Name</label>
        <input type="text" id="name" name="name" required>
      </div>
      <div class="form-group">
        <label for="description">Description</label>
        <textarea id="description" name="description" rows="3" required></textarea>
      </div>
      <div class="form-group">
        <label for="max_attendees">Max Attendees</label>
        <input type="number" id="max_attendees" name="max_attendees" min="1" required>
      </div>
      <div class="form-group">
        <label for="thank_you_url">Thank You URL</label>
        <input type="url" id="thank_you_url" name="thank_you_url" required placeholder="https://example.com/thank-you">
      </div>
      <button type="submit">Create Event</button>
    </form>
  `);
};
var renderAttendeeRow = (a) => `
  <tr>
    <td>${escapeHtml(a.name)}</td>
    <td>${escapeHtml(a.email)}</td>
    <td>${new Date(a.created).toLocaleString()}</td>
  </tr>
`;
var adminEventPage = (event, attendees) => {
  const attendeeRows = attendees.length > 0 ? pipe(map(renderAttendeeRow), joinStrings)(attendees) : '<tr><td colspan="3">No attendees yet</td></tr>';
  return layout(`Event: ${event.name}`, `
    <h1>${escapeHtml(event.name)}</h1>
    <p><a href="/admin/">&larr; Back to Dashboard</a></p>

    <h2>Event Details</h2>
    <p><strong>Description:</strong> ${escapeHtml(event.description)}</p>
    <p><strong>Max Attendees:</strong> ${event.max_attendees}</p>
    <p><strong>Current Attendees:</strong> ${event.attendee_count}</p>
    <p><strong>Spots Remaining:</strong> ${event.max_attendees - event.attendee_count}</p>
    <p><strong>Thank You URL:</strong> <a href="${escapeHtml(event.thank_you_url)}">${escapeHtml(event.thank_you_url)}</a></p>
    <p><strong>Ticket URL:</strong> <a href="/ticket/${event.id}">/ticket/${event.id}</a></p>

    <h2>Attendees</h2>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Registered</th>
        </tr>
      </thead>
      <tbody>
        ${attendeeRows}
      </tbody>
    </table>
  `);
};
var ticketPage = (event, error) => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isFull = spotsRemaining <= 0;
  return layout(`Reserve Ticket: ${event.name}`, `
    <h1>${escapeHtml(event.name)}</h1>
    <p>${escapeHtml(event.description)}</p>
    <p><strong>Spots remaining:</strong> ${spotsRemaining}</p>

    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}

    ${isFull ? '<div class="error">Sorry, this event is full.</div>' : `
      <form method="POST" action="/ticket/${event.id}">
        <div class="form-group">
          <label for="name">Your Name</label>
          <input type="text" id="name" name="name" required>
        </div>
        <div class="form-group">
          <label for="email">Your Email</label>
          <input type="email" id="email" name="email" required>
        </div>
        <button type="submit">Reserve Ticket</button>
      </form>
    `}
  `);
};
var notFoundPage = () => layout("Not Found", `
    <h1>Event Not Found</h1>
    <p>The event you're looking for doesn't exist.</p>
  `);
var homePage = () => layout("Ticket Reservation System", `
    <h1>Ticket Reservation System</h1>
    <p>Welcome to the ticket reservation system.</p>
    <p><a href="/admin/">Admin Login</a></p>
  `);

// src/server.ts
var sessions = new Map;
var generateSessionToken = () => {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let token = "";
  for (let i = 0;i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
};
var parseCookies = (request) => {
  const cookies = new Map;
  const header = request.headers.get("cookie");
  if (!header)
    return cookies;
  for (const part of header.split(";")) {
    const [key, value] = part.trim().split("=");
    if (key && value) {
      cookies.set(key, value);
    }
  }
  return cookies;
};
var isAuthenticated = (request) => {
  const cookies = parseCookies(request);
  const token = cookies.get("session");
  if (!token)
    return false;
  const session = sessions.get(token);
  if (!session)
    return false;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
};
var htmlResponse = (html, status = 200) => new Response(html, {
  status,
  headers: { "content-type": "text/html; charset=utf-8" }
});
var redirect = (url, cookie) => {
  const headers = { location: url };
  if (cookie) {
    headers["set-cookie"] = cookie;
  }
  return new Response(null, { status: 302, headers });
};
var parseFormData = async (request) => {
  const text = await request.text();
  return new URLSearchParams(text);
};
var handleAdminGet = async (request) => {
  if (!isAuthenticated(request)) {
    return htmlResponse(adminLoginPage());
  }
  const events = await getAllEvents();
  return htmlResponse(adminDashboardPage(events));
};
var handleAdminLogin = async (request) => {
  const form = await parseFormData(request);
  const password = form.get("password") || "";
  const valid = await verifyAdminPassword(password);
  if (!valid) {
    return htmlResponse(adminLoginPage("Invalid password"), 401);
  }
  const token = generateSessionToken();
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  sessions.set(token, { expires });
  return redirect("/admin/", `session=${token}; HttpOnly; Path=/; Max-Age=86400`);
};
var handleAdminLogout = (request) => {
  const cookies = parseCookies(request);
  const token = cookies.get("session");
  if (token) {
    sessions.delete(token);
  }
  return redirect("/admin/", "session=; HttpOnly; Path=/; Max-Age=0");
};
var handleCreateEvent = async (request) => {
  if (!isAuthenticated(request)) {
    return redirect("/admin/");
  }
  const form = await parseFormData(request);
  const name = form.get("name") || "";
  const description = form.get("description") || "";
  const maxAttendees = Number.parseInt(form.get("max_attendees") || "0", 10);
  const thankYouUrl = form.get("thank_you_url") || "";
  await createEvent(name, description, maxAttendees, thankYouUrl);
  return redirect("/admin/");
};
var handleAdminEventGet = async (request, eventId) => {
  if (!isAuthenticated(request)) {
    return redirect("/admin/");
  }
  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }
  const attendees = await getAttendees(eventId);
  return htmlResponse(adminEventPage(event, attendees));
};
var handleTicketGet = async (eventId) => {
  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }
  return htmlResponse(ticketPage(event));
};
var handleTicketPost = async (request, eventId) => {
  const event = await getEventWithCount(eventId);
  if (!event) {
    return htmlResponse(notFoundPage(), 404);
  }
  const form = await parseFormData(request);
  const name = form.get("name") || "";
  const email = form.get("email") || "";
  if (!name.trim() || !email.trim()) {
    return htmlResponse(ticketPage(event, "Name and email are required"), 400);
  }
  const available = await hasAvailableSpots(eventId);
  if (!available) {
    return htmlResponse(ticketPage(event, "Sorry, this event is now full"), 400);
  }
  await createAttendee(eventId, name.trim(), email.trim());
  return redirect(event.thank_you_url);
};
var routeAdminEvent = async (request, path, method) => {
  const eventMatch = path.match(/^\/admin\/event\/(\d+)$/);
  if (eventMatch?.[1] && method === "GET") {
    return handleAdminEventGet(request, Number.parseInt(eventMatch[1], 10));
  }
  return null;
};
var isAdminRoot = (path) => path === "/admin/" || path === "/admin";
var routeAdminAuth = async (request, path, method) => {
  if (path === "/admin/login" && method === "POST") {
    return handleAdminLogin(request);
  }
  if (path === "/admin/logout" && method === "GET") {
    return handleAdminLogout(request);
  }
  return null;
};
var routeAdminCore = async (request, path, method) => {
  if (isAdminRoot(path) && method === "GET") {
    return handleAdminGet(request);
  }
  if (path === "/admin/event" && method === "POST") {
    return handleCreateEvent(request);
  }
  return routeAdminAuth(request, path, method);
};
var routeAdmin = async (request, path, method) => {
  const coreResponse = await routeAdminCore(request, path, method);
  if (coreResponse)
    return coreResponse;
  return routeAdminEvent(request, path, method);
};
var routeTicket = async (request, path, method) => {
  const match = path.match(/^\/ticket\/(\d+)$/);
  if (!match?.[1])
    return null;
  const eventId = Number.parseInt(match[1], 10);
  if (method === "GET") {
    return handleTicketGet(eventId);
  }
  if (method === "POST") {
    return handleTicketPost(request, eventId);
  }
  return null;
};
var handleRequest = async (request) => {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (path === "/" && method === "GET") {
    return htmlResponse(homePage());
  }
  if (path === "/health" && method === "GET") {
    return new Response(JSON.stringify({ status: "ok" }), {
      headers: { "content-type": "application/json" }
    });
  }
  const adminResponse = await routeAdmin(request, path, method);
  if (adminResponse)
    return adminResponse;
  const ticketResponse = await routeTicket(request, path, method);
  if (ticketResponse)
    return ticketResponse;
  return htmlResponse(notFoundPage(), 404);
};

// src/edge/bunny-script.ts
console.log("[Tickets] Edge script module loaded");
var initialized = false;
console.log("[Tickets] Registering HTTP handler...");
BunnySDK.net.http.serve(async (request) => {
  try {
    if (!initialized) {
      console.log("[Tickets] Initializing database...");
      await initDb();
      initialized = true;
      console.log("[Tickets] Database initialized successfully");
    }
    return handleRequest(request);
  } catch (error) {
    console.error("[Tickets] Request error:", error);
    return new Response(JSON.stringify({
      error: "Internal server error",
      message: String(error)
    }), { status: 500, headers: { "content-type": "application/json" } });
  }
});
console.log("[Tickets] HTTP handler registered");
