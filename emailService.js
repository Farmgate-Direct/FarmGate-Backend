/* =========================================================
   FARMGATE BRANDED EMAILS (Gmail SMTP via nodemailer)
   - GMAIL_USER + GMAIL_APP_PASSWORD env vars (same account as
     the auto-reject script). Kapag wala, skip nang tahimik —
     ang caller ang magfa-fallback (default Firebase email).
   - Lahat ng emails ay HTML na naka-FarmGate design
     (green #14532d header) + plain-text fallback.
========================================================= */

let nodemailer = null;

try {
  nodemailer = require("nodemailer");
} catch {
  nodemailer = null;
}

const getEnv = (name) => {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value.trim();
};

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const isSmtpConfigured = () =>
  Boolean(nodemailer && getEnv("GMAIL_USER") && getEnv("GMAIL_APP_PASSWORD"));

let cachedTransporter = null;

const getTransporter = () => {
  if (!isSmtpConfigured()) return null;
  if (!cachedTransporter) {
    cachedTransporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: getEnv("GMAIL_USER"), pass: getEnv("GMAIL_APP_PASSWORD") },
    });
  }
  return cachedTransporter;
};

/* ---------- Shared branded wrapper (inline CSS para sa Gmail) ---------- */

const wrapBranded = ({ preheader, title, bodyHtml }) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background-color:#f3f4f6;font-family:Arial,Helvetica,sans-serif;">
  <span style="display:none;max-height:0;overflow:hidden;opacity:0;">${preheader}</span>
  <div style="padding:24px 12px;">
    <div style="max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:12px;overflow:hidden;">
      <div style="background-color:#14532d;padding:28px 24px;text-align:center;">
        <div style="color:#ffffff;font-size:22px;font-weight:bold;letter-spacing:2px;">FARMGATE DIRECT</div>
        <div style="color:#bbf7d0;font-size:13px;margin-top:6px;">From the hands of farmers to the homes of buyers.</div>
      </div>
      <div style="padding:28px 24px;color:#374151;font-size:15px;line-height:1.6;">
        <div style="font-size:18px;font-weight:bold;color:#111827;margin-bottom:12px;">${title}</div>
        ${bodyHtml}
      </div>
      <div style="padding:16px 24px 24px;color:#9ca3af;font-size:12px;line-height:1.5;border-top:1px solid #f3f4f6;">
        Ito ay awtomatikong mensahe mula sa FarmGate Direct. Huwag mag-reply sa email na ito.
      </div>
    </div>
  </div>
</body>
</html>`;

const buttonHtml = (label, url) => `
<div style="text-align:center;margin:24px 0;">
  <a href="${url}" style="display:inline-block;background-color:#14532d;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;padding:14px 32px;border-radius:8px;">${label}</a>
</div>`;

const reasonsHtml = (reasons) => {
  if (!Array.isArray(reasons) || reasons.length === 0) return "";
  const items = reasons.map((r) => `<li style="margin-bottom:6px;">${escapeHtml(r)}</li>`).join("");
  return `<div style="background-color:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:14px 18px;margin:16px 0;">
    <div style="font-weight:bold;color:#14532d;margin-bottom:8px;">Dahilan:</div>
    <ul style="margin:0;padding-left:20px;color:#374151;">${items}</ul>
  </div>`;
};

/* ---------- Verification email ---------- */

const buildVerification = (fullName, link) => {
  const name = escapeHtml(fullName || "ka-FarmGate");
  const safeLink = escapeHtml(link);
  return {
    subject: "Verify your FarmGate Direct email",
    text:
      `Hi ${fullName || "ka-FarmGate"},\n\n` +
      `I-click ang link na ito para i-verify ang iyong email address:\n${link}\n\n` +
      `Kung hindi ikaw ang nag-request nito, huwag pansinin ang email na ito.\n\n` +
      `Salamat,\nFarmGate Direct`,
    html: wrapBranded({
      preheader: "I-verify ang iyong FarmGate Direct email address.",
      title: `Hi ${name},`,
      bodyHtml:
        `<p style="margin:0 0 12px;">I-click ang button sa ibaba para i-verify ang iyong email address at ipagpatuloy ang registration.</p>` +
        buttonHtml("Verify my email", safeLink) +
        `<p style="margin:0 0 8px;color:#6b7280;font-size:13px;">Kung hindi gumagana ang button, kopyahin ang link na ito sa browser:</p>` +
        `<p style="margin:0;color:#14532d;font-size:12px;word-break:break-all;">${safeLink}</p>` +
        `<p style="margin:16px 0 0;color:#6b7280;font-size:13px;">Kung hindi ikaw ang nag-request nito, huwag pansinin ang email na ito.</p>`,
    }),
  };
};

/* ---------- Rejection email (manual + auto) ---------- */

const DEFAULT_MANUAL_REASON =
  "Hindi pumasa sa manual review ng admin ang iyong registration.";

const buildRejection = (fullName, reasons) => {
  const list =
    Array.isArray(reasons) && reasons.length > 0 ? reasons : [DEFAULT_MANUAL_REASON];
  const name = escapeHtml(fullName || "ka-FarmGate");
  const reasonLines = list.map((r) => `- ${r}`).join("\n");
  return {
    subject: "FarmGate Direct: hindi naaprubahan ang registration",
    text:
      `Hi ${fullName || "ka-FarmGate"},\n\n` +
      `Hindi naaprubahan ang iyong FarmGate Direct registration:\n\n` +
      `${reasonLines}\n\n` +
      `Maaari kang mag-register muli gamit ang tama at tugmang ` +
      `impormasyon (ang pangalan sa Valid ID at sa registration ay ` +
      `dapat magkapareho).\n\n` +
      `Salamat,\nFarmGate Direct`,
    html: wrapBranded({
      preheader: "Hindi naaprubahan ang iyong FarmGate Direct registration.",
      title: `Hi ${name},`,
      bodyHtml:
        `<p style="margin:0;">Hindi naaprubahan ang iyong FarmGate Direct registration.</p>` +
        reasonsHtml(list) +
        `<p style="margin:16px 0 0;">Maaari kang mag-register muli gamit ang tama at tugmang impormasyon (ang pangalan sa Valid ID at sa registration ay dapat magkapareho).</p>` +
        `<p style="margin:12px 0 0;">Salamat,<br><strong>FarmGate Direct</strong></p>`,
    }),
  };
};

/* ---------- Approval email (manual approve) ---------- */

const buildApproval = (fullName) => {
  const name = escapeHtml(fullName || "ka-FarmGate");
  return {
    subject: "FarmGate Direct: naaprubahan ang iyong registration",
    text:
      `Hi ${fullName || "ka-FarmGate"},\n\n` +
      `Magandang balita! Naaprubahan na ang iyong FarmGate Direct registration.\n\n` +
      `Maaari ka nang mag-sign in gamit ang iyong email at password.\n\n` +
      `Salamat,\nFarmGate Direct`,
    html: wrapBranded({
      preheader: "Naaprubahan na ang iyong FarmGate Direct registration.",
      title: `Hi ${name},`,
      bodyHtml:
        `<p style="margin:0;">Magandang balita! <strong>Naaprubahan</strong> na ang iyong FarmGate Direct registration.</p>` +
        `<p style="margin:16px 0 0;">Maaari ka nang mag-sign in gamit ang iyong email at password.</p>` +
        `<p style="margin:12px 0 0;">Salamat,<br><strong>FarmGate Direct</strong></p>`,
    }),
  };
};

/* ---------- Senders ---------- */

const sendMail = async ({ to, subject, text, html }) => {
  const transporter = getTransporter();
  if (!transporter) return false;
  if (!to || !String(to).includes("@")) return false;
  await transporter.sendMail({
    from: `"FarmGate Direct" <${getEnv("GMAIL_USER")}>`,
    to,
    subject,
    text,
    html,
  });
  return true;
};

const sendVerificationEmail = async (toEmail, fullName, link) => {
  try {
    const { subject, text, html } = buildVerification(fullName, link);
    const sent = await sendMail({ to: toEmail, subject, text, html });
    if (sent) console.log(`[EMAIL] Verification sent to ${toEmail}.`);
    return sent;
  } catch (error) {
    console.error(`[EMAIL] Verification failed: ${error?.message || error}`);
    return false;
  }
};

const sendRejectionEmail = async (toEmail, fullName, reasons) => {
  try {
    const { subject, text, html } = buildRejection(fullName, reasons);
    const sent = await sendMail({ to: toEmail, subject, text, html });
    if (sent) console.log(`[EMAIL] Rejection sent to ${toEmail}.`);
    else console.log("[EMAIL] Rejection skipped (walang SMTP config).");
    return sent;
  } catch (error) {
    console.error(`[EMAIL] Rejection failed: ${error?.message || error}`);
    return false;
  }
};

const sendApprovalEmail = async (toEmail, fullName) => {
  try {
    const { subject, text, html } = buildApproval(fullName);
    const sent = await sendMail({ to: toEmail, subject, text, html });
    if (sent) console.log(`[EMAIL] Approval sent to ${toEmail}.`);
    else console.log("[EMAIL] Approval skipped (walang SMTP config).");
    return sent;
  } catch (error) {
    console.error(`[EMAIL] Approval failed: ${error?.message || error}`);
    return false;
  }
};

module.exports = {
  isSmtpConfigured,
  sendVerificationEmail,
  sendRejectionEmail,
  sendApprovalEmail,
};
