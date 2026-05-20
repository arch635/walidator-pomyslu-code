"use strict";

// mailer.js - SES SendEmail z attachment PDF (multipart raw).
// FROM = noreply@theinnerspace.pl (env REPORT_FROM)
// Reply-To = artur@racicki.com (env REPORT_REPLY_TO)
// SES region: eu-central-1.

const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");

const REGION = process.env.AWS_REGION || "eu-central-1";
const ses = new SESv2Client({ region: REGION });

const DEFAULT_FROM = process.env.REPORT_FROM || "noreply@theinnerspace.pl";
const DEFAULT_REPLY_TO = process.env.REPORT_REPLY_TO || "artur@racicki.com";

function isValidEmail(email) {
  return typeof email === "string"
    && email.length >= 5
    && email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Buduje raw MIME message z PDF jako attachment.
function buildRawMime({ from, to, replyTo, subject, htmlBody, textBody, pdfBuffer, pdfFilename }) {
  const boundary = "----=_Part_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const altBoundary = "----=_Alt_" + Math.random().toString(36).slice(2) + Date.now().toString(36);

  // Subject encoded (UTF-8 Base64 jeśli zawiera non-ASCII).
  const encodedSubject = encodeMimeWord(subject);

  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Reply-To: ${replyTo}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`
  ];

  const lines = [];
  lines.push(headers.join("\r\n"));
  lines.push("");
  lines.push("This is a multi-part message in MIME format.");
  lines.push("");

  // Alt part (text + html)
  lines.push(`--${boundary}`);
  lines.push(`Content-Type: multipart/alternative; boundary="${altBoundary}"`);
  lines.push("");

  lines.push(`--${altBoundary}`);
  lines.push("Content-Type: text/plain; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(Buffer.from(textBody, "utf-8").toString("base64").replace(/(.{76})/g, "$1\r\n"));
  lines.push("");

  lines.push(`--${altBoundary}`);
  lines.push("Content-Type: text/html; charset=UTF-8");
  lines.push("Content-Transfer-Encoding: base64");
  lines.push("");
  lines.push(Buffer.from(htmlBody, "utf-8").toString("base64").replace(/(.{76})/g, "$1\r\n"));
  lines.push("");
  lines.push(`--${altBoundary}--`);
  lines.push("");

  // Attachment PDF
  lines.push(`--${boundary}`);
  lines.push(`Content-Type: application/pdf; name="${pdfFilename}"`);
  lines.push("Content-Transfer-Encoding: base64");
  lines.push(`Content-Disposition: attachment; filename="${pdfFilename}"`);
  lines.push("");
  lines.push(pdfBuffer.toString("base64").replace(/(.{76})/g, "$1\r\n"));
  lines.push("");
  lines.push(`--${boundary}--`);
  lines.push("");

  return lines.join("\r\n");
}

function encodeMimeWord(s) {
  // Tylko jeśli zawiera non-ASCII, użyj =?UTF-8?B?...?=
  if (/^[\x00-\x7F]*$/.test(s)) return s;
  return "=?UTF-8?B?" + Buffer.from(s, "utf-8").toString("base64") + "?=";
}

async function sendReportEmail({ to, subject, htmlBody, textBody, pdfBuffer, pdfFilename, from, replyTo }) {
  const fromAddr = from || DEFAULT_FROM;
  const replyToAddr = replyTo || DEFAULT_REPLY_TO;

  const raw = buildRawMime({
    from: fromAddr,
    to,
    replyTo: replyToAddr,
    subject,
    htmlBody,
    textBody,
    pdfBuffer,
    pdfFilename: pdfFilename || "raport.pdf"
  });

  const cmd = new SendEmailCommand({
    FromEmailAddress: fromAddr,
    Destination: { ToAddresses: [to] },
    ReplyToAddresses: [replyToAddr],
    Content: { Raw: { Data: Buffer.from(raw, "utf-8") } }
  });

  const res = await ses.send(cmd);
  return res.MessageId;
}

module.exports = { sendReportEmail, isValidEmail };
