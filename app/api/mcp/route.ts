import { verifyClerkToken } from "@clerk/mcp-tools/next";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import { listRecentEmails } from "../../../lib/icloud";

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

const handler = createMcpHandler((server) => {
  server.registerTool(
    "list_recent_emails",
    {
      title: "List recent iCloud emails",
      description:
        "Lists the most recent messages in the connected iCloud Mail inbox. Returns sender, subject, date, unread status, and IMAP UID. This tool is read-only and does not return message bodies.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(20).default(5),
      }),
    },
    async ({ limit }, ctx) => {
      try {
        const userId = ctx.http?.authInfo?.extra?.userId;
        if (typeof userId !== "string" || !userId) {
          throw new Error("Authenticated Clerk user ID is missing.");
        }

        await assertMailboxOwner(userId);
        const emails = await listRecentEmails(limit);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ emails }, null, 2),
            },
          ],
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
