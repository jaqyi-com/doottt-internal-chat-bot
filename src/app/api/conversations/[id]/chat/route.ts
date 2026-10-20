import { isAuthed, unauthorized } from "@/lib/auth";
import { getConversation } from "@/lib/repo";
import { runTurn } from "@/lib/agent/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Several LLM calls + DB queries per turn; Vercel Fluid compute allows up to 300s.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

// Streams progress as Server-Sent Events: {type:"step"} … then {type:"final", message}.
export async function POST(req: Request, { params }: Ctx) {
  if (!(await isAuthed())) return unauthorized();
  const { id } = await params;
  if (!(await getConversation(id))) return Response.json({ error: "not found" }, { status: 404 });
  const { message } = (await req.json().catch(() => ({}))) as { message?: string };
  if (!message?.trim()) return Response.json({ error: "message required" }, { status: 400 });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      try {
        const final = await runTurn(id, message.trim().slice(0, 8000), (e) => send(e));
        send({ type: "final", message: final });
      } catch (err) {
        send({ type: "error", error: String((err as Error)?.message || err).slice(0, 300) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}
