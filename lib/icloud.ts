import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

export type RecentEmail = {
  uid: number;
  from: string;
  subject: string;
  date: string | null;
  unread: boolean;
};

export type ReadEmail = {
  uid: number;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  subject: string;
  date: string | null;
  messageId: string | null;
  unread: boolean;
  body: string;
  bodyTruncated: boolean;
  attachments: Array<{
    filename: string;
    contentType: string;
    size: number;
  }>;
};

export type SendEmailInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
};

export type SendEmailResult = {
  sent: boolean;
  from: string;
  messageId: string | null;
  accepted: string[];
  rejected: string[];
};

const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_CHARS = 100_000;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function getFromAddress(): string {
  return process.env.ICLOUD_FROM_ADDRESS?.trim() || "hi@shahshlok.com";
}

function createImapClient(): ImapFlow {
  const user = requiredEnv("ICLOUD_IMAP_USERNAME");
  const pass = requiredEnv("ICLOUD_APP_PASSWORD");

  return new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

function formatAddressList(
  addresses: Array<{ name?: string | null; address?: string | null }> | undefined,
): string {
  if (!addresses?.length) return "";

  return addresses
    .map((item) => {
      const address = item.address?.trim();
      const name = item.name?.trim();
      if (name && address) return `${name} <${address}>`;
      return address || name || "";
    })
    .filter(Boolean)
    .join(", ");
}

function parsedAddressText(value: unknown): string {
  if (!value) return "";

  if (Array.isArray(value)) {
    return value
      .map((item) => parsedAddressText(item))
      .filter(Boolean)
      .join(", ");
  }

  if (typeof value === "object" && value !== null && "text" in value) {
    const text = (value as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }

  return "";
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function truncateBody(body: string): { body: string; bodyTruncated: boolean } {
  if (body.length <= MAX_BODY_CHARS) {
    return { body, bodyTruncated: false };
  }

  return {
    body: `${body.slice(0, MAX_BODY_CHARS)}\n\n[Body truncated by iCloud Mail MCP]`,
    bodyTruncated: true,
  };
}

function normalizeAddresses(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value));
}

export async function listRecentEmails(limit: number): Promise<RecentEmail[]> {
  const client = createImapClient();
  await client.connect();

  try {
    const lock = await client.getMailboxLock("INBOX");

    try {
      const mailbox = client.mailbox;
      if (!mailbox) {
        throw new Error("INBOX is not open");
      }

      const exists = mailbox.exists;
      if (!exists) return [];

      const start = Math.max(1, exists - limit + 1);
      const emails: RecentEmail[] = [];

      for await (const message of client.fetch(`${start}:*`, {
        uid: true,
        envelope: true,
        flags: true,
        internalDate: true,
      })) {
        const flags = message.flags ?? new Set<string>();
        const messageDate = message.envelope?.date ?? message.internalDate ?? null;

        emails.push({
          uid: message.uid,
          from: formatAddressList(message.envelope?.from) || "(unknown sender)",
          subject: message.envelope?.subject || "(no subject)",
          date: toIsoString(messageDate),
          unread: !flags.has("\\Seen"),
        });
      }

      return emails
        .sort((a, b) => {
          if (!a.date) return 1;
          if (!b.date) return -1;
          return b.date.localeCompare(a.date);
        })
        .slice(0, limit);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function readEmail(uid: number): Promise<ReadEmail> {
  const client = createImapClient();
  await client.connect();

  try {
    const lock = await client.getMailboxLock("INBOX");

    try {
      const metadata = await client.fetchOne(
        uid,
        {
          uid: true,
          envelope: true,
          flags: true,
          internalDate: true,
          size: true,
        },
        { uid: true },
      );

      if (!metadata) {
        throw new Error(`No INBOX message found with UID ${uid}.`);
      }

      if (metadata.size && metadata.size > MAX_MESSAGE_BYTES) {
        throw new Error(
          `Message UID ${uid} is ${(metadata.size / 1024 / 1024).toFixed(1)} MB, which exceeds the current 5 MB read limit.`,
        );
      }

      const sourceMessage = await client.fetchOne(
        uid,
        { source: true },
        { uid: true },
      );

      if (!sourceMessage || !sourceMessage.source) {
        throw new Error(`Could not retrieve the body for message UID ${uid}.`);
      }

      const parsed = await simpleParser(sourceMessage.source, {
        skipTextToHtml: true,
        skipImageLinks: true,
        maxHtmlLengthToParse: 1_000_000,
      });

      const rawBody = parsed.text?.trim() || "(No readable text body found.)";
      const { body, bodyTruncated } = truncateBody(rawBody);
      const flags = metadata.flags ?? new Set<string>();

      return {
        uid: metadata.uid,
        from:
          parsedAddressText(parsed.from) ||
          formatAddressList(metadata.envelope?.from) ||
          "(unknown sender)",
        to: parsedAddressText(parsed.to) || formatAddressList(metadata.envelope?.to),
        cc: parsedAddressText(parsed.cc) || formatAddressList(metadata.envelope?.cc),
        replyTo: parsedAddressText(parsed.replyTo),
        subject: parsed.subject || metadata.envelope?.subject || "(no subject)",
        date: toIsoString(
          parsed.date ?? metadata.envelope?.date ?? metadata.internalDate ?? null,
        ),
        messageId: parsed.messageId || metadata.envelope?.messageId || null,
        unread: !flags.has("\\Seen"),
        body,
        bodyTruncated,
        attachments: parsed.attachments.map((attachment) => ({
          filename: attachment.filename || "(unnamed attachment)",
          contentType: attachment.contentType || "application/octet-stream",
          size: attachment.size || 0,
        })),
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const user = requiredEnv("ICLOUD_IMAP_USERNAME");
  const pass = requiredEnv("ICLOUD_APP_PASSWORD");
  const from = getFromAddress();

  const transporter = nodemailer.createTransport({
    host: "smtp.mail.me.com",
    port: 587,
    secure: false,
    requireTLS: true,
    auth: { user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

  const info = await transporter.sendMail({
    from,
    to: input.to,
    cc: input.cc?.length ? input.cc : undefined,
    bcc: input.bcc?.length ? input.bcc : undefined,
    subject: input.subject,
    text: input.body,
  });

  transporter.close();

  return {
    sent: true,
    from,
    messageId: info.messageId || null,
    accepted: normalizeAddresses(info.accepted),
    rejected: normalizeAddresses(info.rejected),
  };
}
