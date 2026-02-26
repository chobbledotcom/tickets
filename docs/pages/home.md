---
permalink: "/"
layout: "home.html"
---

# Chobble Tickets

A self-hosted ticket reservation system that runs on Bunny Edge Scripting with libsql. All personal data is encrypted at rest. Handles both free and paid events with Stripe or Square.

Licensed under **AGPLv3**. Hosted instances available at [tix.chobble.com](https://tix.chobble.com/ticket/register) for £50/year, no tiers.

## Events

Create standard events with fixed capacity or daily events with per-date capacity and a calendar picker. Configure contact fields (email, phone, postal address) in any combination, set terms and conditions, capacity limits, and registration deadlines.

Combine multiple events into a single booking URL, embed registration forms via iframe, or add manual attendees for walk-ins and comps.

## Payments

Connect Stripe or Square by entering your API key in admin settings — the webhook endpoint configures itself automatically. Checkout sessions track metadata, attendees are created on webhook confirmation, and automatic refunds are issued if capacity is exceeded after payment.

Admins can issue full refunds for individual attendees or in bulk.

## Check-in

Every ticket gets a unique URL with a QR code. Staff scan the QR to reach the check-in page and toggle attendance. A built-in QR scanner uses the device camera for check-in-only scanning, with cross-event detection to warn if a ticket belongs to a different event.

## Security and encryption

Attendee PII is encrypted with hybrid RSA-OAEP + AES-256-GCM. The public key encrypts on submission without authentication; the private key is only available to authenticated admin sessions. A database breach alone does not expose personal data.

Passwords are hashed with PBKDF2 (600k iterations). Sessions use HttpOnly cookies with hashed tokens and 24-hour expiry. CSRF protection uses double-submit cookies with 256-bit random tokens. Rate limiting locks out IPs after 5 failed login attempts for 15 minutes.

## Admin

Manage events, view attendee lists with filtering, export to CSV, and review per-event activity logs. Configure payment providers, embed restrictions, and terms from the settings page. Invite additional managers via time-limited links.

## Deployment

Builds to a single JavaScript file for Bunny Edge Scripting. The database schema auto-migrates on first request. Configure `DB_URL`, `DB_TOKEN`, `DB_ENCRYPTION_KEY`, and `ALLOWED_DOMAIN` as Bunny native secrets.

On first launch, visit `/setup/` to set admin credentials and currency.
