import { isAuthed, unauthorized } from "@/lib/auth";
import { deleteConversation, getConversation, listMessages, renameConversation } from "@/lib/repo";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Ctx) {
  if (!(await isAuthed())) return unauthorized();
  const { id } = await params;
  const conversation = await getConversation(id);
  if (!conversation) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ conversation, messages: await listMessages(id) });
}

export async function PATCH(req: Request, { params }: Ctx) {
  if (!(await isAuthed())) return unauthorized();
  const { id } = await params;
  const { title } = (await req.json().catch(() => ({}))) as { title?: string };
  if (!title?.trim()) return Response.json({ error: "title required" }, { status: 400 });
  await renameConversation(id, title.trim());
  return Response.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: Ctx) {
  if (!(await isAuthed())) return unauthorized();
  const { id } = await params;
  await deleteConversation(id);
  return Response.json({ ok: true });
}
