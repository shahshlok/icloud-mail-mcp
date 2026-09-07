import { ImapFlow } from "imapflow";

export type RecentEmail = {
  uid: number;
  from: string;
  subject: string;
  date: string | null;
  unread: boolean;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function formatAddressList(
  addresses: Array<{ name?: string | null; address?: string | null }> | undefined,
): string {
  if (!addresses?.length) return "(unknown sender)";

  return addresses
    .map((item) => {
      const address = item.address?.trim();
      const name = item.name?.trim();
      if (name && address) return `${name} <${address}>`;
      return address || name || "(unknown sender)";
    })
    .join(", ");
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) return null;

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function listRecentEmails(limit: number): Promise<RecentEmail[]> {
  const user = requiredEnv("ICLOUD_IMAP_USERNAME");
  const pass = requiredEnv("ICLOUD_APP_PASSWORD");

  const client = new ImapFlow({
    host: "imap.mail.me.com",
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });

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
          from: formatAddressList(message.envelope?.from),
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
