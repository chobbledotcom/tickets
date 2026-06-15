/**
 * Email sending, templates, and notifications.
 *
 * Supports multiple email providers via HTTP APIs:
 * Resend, Postmark, SendGrid, and Mailgun.
 *
 * Emails are rendered using Liquid templates with support
 * for custom confirmation and admin notification templates.
 *
 * @module
 */

export * from "#shared/email.ts";
export * from "#shared/email-renderer.ts";
export * from "#shared/ntfy.ts";
export * from "#shared/validation/email.ts";
