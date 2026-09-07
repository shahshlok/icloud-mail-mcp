import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import {
  listRecentEmails,
  readEmail,
  sendEmail,
} from "../../../lib/icloud";

export const runtime = "nodejs";
export const maxDuration = 60;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function assertMailboxOwner(userId: string): Promise<void> {
  const ownerEmail = requiredEnv("MCP_OWNER_EMAIL").toLowerCase();
  const clerk = await clerkClient();
  const user = await clerk.users.getUser(userId);

  const ownsMailbox = user.emailAddresses.some(
    (entry) => entry.emailAddress.toLowerCase() === ownerEmail,
  );

  if (!ownsMailbox) {
    throw new Error("This authenticated Clerk user is not authorized for this mailbox.");
  }
}

function authenticatedUserId(ctx: {
  http?: { authInfo?: { extra?: Record<string, unknown> } };
}): string {
  const userId = ctx.http?.authInfo?.extra?.userId;
  if (typeof userId !== "string" || !userId) {
    throw new Error("Authenticated Clerk user ID is missing.");
  }
  return userId;
}

const recentEmailSchema = z.object({
  uid: z.number().int(),
  from: z.string(),
  subject: z.string(),
  date: z.string().nullable(),
  unread: z.boolean(),
});

const attachmentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  size: z.number().int().nonnegative(),
});

const readEmailSchema = z.object({
  uid: z.number().int(),
  from: z.string(),
  to: z.string(),
  cc: z.string(),
  replyTo: z.string(),
  subject: z.string(),
  date: z.string().nullable(),
  messageId: z.string().nullable(),
  unread: z.boolean(),
  body: z.string(),
  bodyTruncated: z.boolean(),
  attachments: z.array(attachmentSchema),
});

const sendResultSchema = z.object({
  sent: z.boolean(),
  from: z.string(),
  messageId: z.string().nullable(),
  accepted: z.array(z.string()),
  rejected: z.array(z.string()),
});

const handler = createMcpHandler((server) => {
  server.registerTool(
    "list_recent_emails",
    {
      title: "List recent iCloud emails",
      description:
        "Lists recent messages in the connected iCloud Mail INBOX. Returns sender, subject, date, unread status, and IMAP UID. Use the UID with read_email to retrieve a message body.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).default(5),
      }),
      outputSchema: z.object({ emails: z.array(recentEmailSchema) }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }, ctx) => {
      try {
        const userId = authenticatedUserId(ctx);
        await assertMailboxOwner(userId);
        const emails = await listRecentEmails(limit);
        const output = { emails };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `iCloud Mail request failed: ${message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "read_email",
    {
      title: "Read iCloud email",
      description:
        "Reads one message from the connected iCloud Mail INBOX by IMAP UID. Returns headers, plain-text body, and attachment metadata. It does not download attachment contents or change read/unread state.",
      inputSchema: z.object({
        uid: z.number().int().positive().describe("IMAP UID returned by list_recent_emails"),
      }),
      outputSchema: z.object({ email: readEmailSchema }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ uid }, ctx) => {
      try {
        const userId = authenticatedUserId(ctx);
        await assertMailboxOwner(userId);
        const email = await readEmail(uid);
        const output = { email };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `iCloud Mail request failed: ${message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "send_email",
    {
      title: "Send iCloud email",
      description:
        "Immediately sends a plain-text email through the connected iCloud Mail account. This is a write action. The From address is fixed by the server and cannot be supplied by the caller.",
      inputSchema: z.object({
        to: z.array(z.string().email()).min(1).max(20),
        cc: z.array(z.string().email()).max(20).optional(),
        bcc: z.array(z.string().email()).max(20).optional(),
        subject: z.string().min(1).max(998),
        body: z.string().min(1).max(200_000),
      }),
      outputSchema: z.object({ result: sendResultSchema }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ to, cc, bcc, subject, body }, ctx) => {
      try {
        const userId = authenticatedUserId(ctx);
        await assertMailboxOwner(userId);
        const result = await sendEmail({ to, cc, bcc, subject, body });
        const output = { result };

        return {
          content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `iCloud Mail send failed: ${message}`,
            },
          ],
        };
      }
    },
  );
});

const authHandler = withMcpAuth(
  handler,
  async (_, token) => {
    const clerkAuth = await auth({ acceptsToken: "oauth_token" });
    return verifyClerkToken(clerkAuth, token);
  },
  {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
  },
);

export { authHandler as GET, authHandler as POST };
