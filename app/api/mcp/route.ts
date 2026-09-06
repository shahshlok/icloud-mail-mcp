import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { listRecentEmails } from "../../../lib/icloud";

export const runtime = "nodejs";
export const maxDuration = 60;

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
    async ({ limit }) => {
      try {
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

export { handler as GET, handler as POST };
