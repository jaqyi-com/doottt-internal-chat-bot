import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";

// Simple shared-password gate: this app exposes contact data, so it must never be open in production.

export const SESSION_COOKIE = "dbot_session";
const MAX_AGE_S = 60 * 60 * 24 * 7;

function secret(): string {
  return process.env.AUTH_SECRET || process.env.APP_PASSWORD || "";
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("hex");
}

export function authEnabled(): boolean {
  return Boolean(process.env.APP_PASSWORD);
}

export function checkPassword(input: string): boolean {
  const expected = process.env.APP_PASSWORD || "";
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function makeSessionToken(): string {
  const exp = Math.floor(Date.now() / 1000) + MAX_AGE_S;
  return `${exp}.${sign(String(exp))}`;
}

export const sessionMaxAge = MAX_AGE_S;

function validToken(token: string | undefined): boolean {
  if (!token) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  const good = sign(exp);
  return sig.length === good.length && timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}

// Production without APP_PASSWORD = locked. Local dev without APP_PASSWORD = open.
export async function isAuthed(): Promise<boolean> {
  if (!authEnabled()) return process.env.NODE_ENV !== "production";
  const jar = await cookies();
  return validToken(jar.get(SESSION_COOKIE)?.value);
}

export function unauthorized() {
  return Response.json({ error: "unauthorized" }, { status: 401 });
}
