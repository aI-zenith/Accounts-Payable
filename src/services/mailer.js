import nodemailer from 'nodemailer';

// Optional outbound email for reminders. Configured via SMTP_* env vars; if
// unset, sendMail() is a no-op (on-screen reminders still work).
let cached;

function transporter() {
  if (cached !== undefined) return cached;
  const host = process.env.SMTP_HOST;
  if (!host) {
    cached = null;
    return cached;
  }
  cached = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
  return cached;
}

export function mailerConfigured() {
  return Boolean(transporter());
}

export async function sendMail({ to, subject, text, html }) {
  const t = transporter();
  if (!t) return false;
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'Zenith Group <no-reply@zenithgroup.local>';
  await t.sendMail({ from, to, subject, text, html });
  return true;
}
