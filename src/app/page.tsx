"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Conversation = { id: string; title: string; updated_at: string };
type Row = Record<string, unknown>;
type MessageData = {
  stage?: string;
  table?: { columns: string[]; rows: Row[] };
  total?: number | null;
  totalIsLowerBound?: boolean;
  resultId?: string;
  options?: string[];
};
type Message = { id: string; role: "user" | "assistant"; content: string; data: MessageData | null; created_at: string };
type Step = { node: string; label: string; detail?: string };

const EXAMPLES = [
  'I need data from category "clothes business" from Rajasthan, give me data with valid mobile number.',
  "Talent Acquisition / Procurement / HRBP managers, leads and heads at GCCs in Bengaluru (IT, BFSI, Engineering). Priority: tech & data hiring.",
  "Restaurants in Pune with email and mobile",
  "Founders and CEOs of software companies in Hyderabad",
];

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (res.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// Tiny markdown: **bold**, paragraphs, line breaks. Text is escaped by React.
function RichText({ text }: { text: string }) {
  return (
    <div className="text">
      {text.split(/\n{2,}/).map((para, i) => (
        <p key={i}>
          {para.split("\n").map((line, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {line.split(/(\*\*[^*]+\*\*)/g).map((part, k) =>
                part.startsWith("**") && part.endsWith("**") ? <strong key={k}>{part.slice(2, -2)}</strong> : <span key={k}>{part}</span>,
              )}
            </span>
          ))}
        </p>
      ))}
    </div>
  );
}

function DataTable({ columns, rows }: { columns: string[]; rows: Row[] }) {
  if (!rows.length) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>#</th>
            {columns.map((c) => (
              <th key={c}>{c.replace(/_/g, " ")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{i + 1}</td>
              {columns.map((c) => {
                const v = r[c] === null || r[c] === undefined ? "" : String(r[c]);
                if (c === "gcc" && v) return <td key={c}><span className={`badge ${v}`}>{v}</span></td>;
                if ((c === "linkedin" || c === "website") && v)
                  return (
                    <td key={c} title={v}>
                      <a href={v.startsWith("http") ? v : `https://${v}`} target="_blank" rel="noreferrer">
                        {v.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40)}
                      </a>
                    </td>
                  );
                return <td key={c} title={v}>{v}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function groupLabel(iso: string): string {
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (days < 1) return "Today";
  if (days < 2) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return "Older";
}

export default function ChatPage() {
  const router = useRouter();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const onAuthError = useCallback(
    (err: unknown) => {
      if ((err as { status?: number })?.status === 401) router.push("/login");
      else setError(String((err as Error)?.message || err));
    },
    [router],
  );

  const loadConvs = useCallback(async () => {
    try {
      const { conversations } = await api<{ conversations: Conversation[] }>("/api/conversations");
      setConvs(conversations);
    } catch (e) {
      onAuthError(e);
    }
  }, [onAuthError]);

  useEffect(() => {
    loadConvs();
    const fromHash = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    if (fromHash) setActiveId(fromHash);
  }, [loadConvs]);

  useEffect(() => {
    if (!activeId) {
      setMessages([]);
      return;
    }
    window.location.hash = activeId;
    api<{ messages: Message[] }>(`/api/conversations/${activeId}`)
      .then(({ messages }) => setMessages(messages))
      .catch((e) => {
        if ((e as Error).message === "not found") setActiveId(null);
        else onAuthError(e);
      });
  }, [activeId, onAuthError]);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, steps]);

  const newChat = () => {
    setActiveId(null);
    setMessages([]);
    setSteps([]);
    setError(null);
    history.replaceState(null, "", "/");
    setSidebarOpen(false);
    taRef.current?.focus();
  };

  const send = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || busy) return;
    setError(null);
    setBusy(true);
    setInput("");
    setSteps([]);
    try {
      let id = activeId;
      if (!id) {
        const { conversation } = await api<{ conversation: Conversation }>("/api/conversations", { method: "POST" });
        id = conversation.id;
        setActiveId(id);
      }
      setMessages((m) => [...m, { id: `tmp-${Date.now()}`, role: "user", content: msg, data: null, created_at: new Date().toISOString() }]);

      const res = await fetch(`/api/conversations/${id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (res.status === 401) throw Object.assign(new Error("unauthorized"), { status: 401 });
      if (!res.ok || !res.body) throw new Error((await res.json().catch(() => ({}))).error || "request failed");

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const events = buf.split("\n\n");
        buf = events.pop() ?? "";
        for (const ev of events) {
          const line = ev.trim();
          if (!line.startsWith("data:")) continue;
          const data = JSON.parse(line.slice(5));
          if (data.type === "step") setSteps((s) => [...s, { node: data.node, label: data.label, detail: data.detail }]);
          if (data.type === "final") setMessages((m) => [...m, data.message as Message]);
          if (data.type === "error") setError(data.error);
        }
      }
      // reload from server so temp ids are replaced
      const { messages: fresh } = await api<{ messages: Message[] }>(`/api/conversations/${id}`);
      setMessages(fresh);
      loadConvs();
    } catch (e) {
      onAuthError(e);
    } finally {
      setBusy(false);
      setSteps([]);
    }
  };

  const rename = async (c: Conversation) => {
    const title = prompt("Rename chat", c.title);
    if (!title?.trim()) return;
    await api(`/api/conversations/${c.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title }) }).catch(onAuthError);
    loadConvs();
  };

  const remove = async (c: Conversation) => {
    if (!confirm(`Delete "${c.title}"?`)) return;
    await api(`/api/conversations/${c.id}`, { method: "DELETE" }).catch(onAuthError);
    if (c.id === activeId) newChat();
    loadConvs();
  };

  const logout = async () => {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
  };

  const grouped: [string, Conversation[]][] = [];
  for (const c of convs) {
    const g = groupLabel(c.updated_at);
    const last = grouped[grouped.length - 1];
    if (last && last[0] === g) last[1].push(c);
    else grouped.push([g, [c]]);
  }
  const activeTitle = convs.find((c) => c.id === activeId)?.title ?? "New chat";
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="app">
      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <button className="new-chat" onClick={newChat}>
          <span>＋</span> New chat
        </button>
        <div className="conv-list">
          {grouped.map(([label, items]) => (
            <div key={label}>
              <div className="conv-group">{label}</div>
              {items.map((c) => (
                <div
                  key={c.id}
                  className={`conv ${c.id === activeId ? "active" : ""}`}
                  onClick={() => {
                    setActiveId(c.id);
                    setSidebarOpen(false);
                  }}
                >
                  <span className="title">{c.title}</span>
                  <span className="actions" onClick={(e) => e.stopPropagation()}>
                    <button className="icon-btn" title="Rename" onClick={() => rename(c)}>✎</button>
                    <button className="icon-btn" title="Delete" onClick={() => remove(c)}>🗑</button>
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <span>Doott Data Bot</span>
          <button className="icon-btn" onClick={logout}>Log out</button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="icon-btn menu" onClick={() => setSidebarOpen((o) => !o)}>☰</button>
          <h1>{activeTitle}</h1>
        </div>

        <div className="thread" ref={threadRef}>
          {messages.length === 0 && !busy ? (
            <div className="empty">
              <h2>What data do you need?</h2>
              <p>Paste the request as you got it. I&apos;ll show a sample first, then you tell me how many records.</p>
              <div className="examples">
                {EXAMPLES.map((e) => (
                  <button key={e} className="example" onClick={() => send(e)}>{e}</button>
                ))}
              </div>
            </div>
          ) : (
            <div className="thread-inner">
              {messages.map((m) => (
                <div key={m.id} className={`msg ${m.role}`}>
                  <div className="bubble">
                    {m.role === "user" ? (
                      m.content
                    ) : (
                      <>
                        <RichText text={m.content} />
                        {m.data?.table && <DataTable columns={m.data.table.columns} rows={m.data.table.rows} />}
                        {m.data?.resultId && (
                          <a className="download" href={`/api/results/${m.data.resultId}/csv`}>
                            ⬇ Download CSV ({m.data.total?.toLocaleString("en-IN")} records)
                          </a>
                        )}
                        {m.data?.options && m === lastAssistant && !busy && (
                          <div className="chips">
                            {m.data.options.map((o) => (
                              <button key={o} className="chip" onClick={() => send(o)}>{o}</button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                </div>
              ))}
              {busy && (
                <div className="msg assistant">
                  <div className="bubble">
                    <div className="steps">
                      {steps.length === 0 && <div className="step live">Thinking</div>}
                      {steps.map((s, i) => (
                        <div key={i} className={`step ${i === steps.length - 1 ? "live" : ""}`}>
                          {s.label}
                          {s.detail ? ` — ${s.detail}` : ""}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {error && <div className="error">⚠ {error}</div>}
            </div>
          )}
        </div>

        <div className="composer">
          <div className="composer-inner">
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              placeholder="Ask for data… e.g. clothes businesses in Rajasthan with mobile"
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            <button className="send" disabled={busy || !input.trim()} onClick={() => send()} aria-label="Send">↑</button>
          </div>
          <div className="hint">Read-only access to Doott DB · results are checked before you see them</div>
        </div>
      </main>
    </div>
  );
}
