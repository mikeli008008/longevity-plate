// Longevity Plate — AI proxy. Keeps the Anthropic key on the server and caps daily use per person.
// Deploy: supabase functions deploy ai
// Secrets: supabase secrets set ANTHROPIC_API_KEY=sk-ant-...   (optional: DAILY_CAP, MODEL_QUICK, MODEL_DEFAULT, MODEL_COMPLEX)
import { createClient } from "npm:@supabase/supabase-js@2";

const MODELS: Record<string, string> = {
  quick: Deno.env.get("MODEL_QUICK") ?? "claude-haiku-5-5",
  default: Deno.env.get("MODEL_DEFAULT") ?? "claude-sonnet-5-5",
  complex: Deno.env.get("MODEL_COMPLEX") ?? "claude-opus-5-5",
};
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: { user } } = await admin.auth.getUser(token);
  if (!user) return json({ error: "not_signed_in" }, 401);

  // daily cap per person
  const day = new Date().toISOString().slice(0, 10);
  const cap = Number(Deno.env.get("DAILY_CAP") ?? "80");
  const { data: usage } = await admin.from("ai_usage").select("calls").eq("user_id", user.id).eq("day", day).maybeSingle();
  const used = usage?.calls ?? 0;
  if (used >= cap) return json({ error: "rate_limited" }, 429);
  await admin.from("ai_usage").upsert({ user_id: user.id, day, calls: used + 1 });

  let body: { prompt?: string; images?: string[]; modelTier?: string };
  try { body = await req.json(); } catch { return json({ error: "bad_request" }, 400); }
  const prompt = String(body.prompt ?? "").slice(0, 200_000);
  if (!prompt) return json({ error: "bad_request" }, 400);
  const images = (body.images ?? []).slice(0, 8);
  const model = MODELS[body.modelTier ?? "default"] ?? MODELS.default;

  const content = [
    ...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })),
    { type: "text", text: prompt },
  ];
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: "user", content }] }),
  });
  const out = await r.json();
  if (!r.ok) return json({ error: out?.error?.message ?? "ai_error" }, 502);
  const text = (out.content ?? []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  return json({ text, truncated: out.stop_reason === "max_tokens" });
});
