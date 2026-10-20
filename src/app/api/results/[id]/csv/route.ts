import { isAuthed, unauthorized } from "@/lib/auth";
import { getResultSet } from "@/lib/repo";

export const runtime = "nodejs";
type Ctx = { params: Promise<{ id: string }> };

function cell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralise spreadsheet formulas, then quote.
  const safe = /^[=+\-@]/.test(s) && !/^\+\d/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export async function GET(_req: Request, { params }: Ctx) {
  if (!(await isAuthed())) return unauthorized();
  const { id } = await params;
  const rs = await getResultSet(id);
  if (!rs) return Response.json({ error: "not found" }, { status: 404 });
  const lines = [rs.columns.map(cell).join(","), ...rs.rows.map((r) => rs.columns.map((c) => cell(r[c])).join(","))];
  const name = `doott-${rs.entity}-${rs.rows.length}-${rs.created_at.slice(0, 10)}.csv`;
  return new Response("﻿" + lines.join("\r\n"), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"` },
  });
}
