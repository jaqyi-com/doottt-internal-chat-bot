import { isAuthed, unauthorized } from "@/lib/auth";
import { createConversation, listConversations } from "@/lib/repo";

export const runtime = "nodejs";

export async function GET() {
  if (!(await isAuthed())) return unauthorized();
  return Response.json({ conversations: await listConversations() });
}

export async function POST() {
  if (!(await isAuthed())) return unauthorized();
  return Response.json({ conversation: await createConversation() });
}
