"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) router.push("/");
    else setError("Wrong password");
  };

  return (
    <div className="login">
      <form onSubmit={submit}>
        <h2 style={{ margin: 0 }}>Doott Data Bot</h2>
        <p style={{ margin: 0, color: "var(--muted)" }}>Internal tool — enter the team password.</p>
        <input type="password" autoFocus placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button disabled={busy || !password}>{busy ? "Checking…" : "Continue"}</button>
        {error && <div className="error">{error}</div>}
      </form>
    </div>
  );
}
