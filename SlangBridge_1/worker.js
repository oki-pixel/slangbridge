/**
 * SlangBridge AI Worker (Cloudflare Workers)
 *
 * The web app sends {prompt, stream} as a plain-text POST body (no CORS preflight).
 * This Worker:
 *   - only answers the site(s) listed in ALLOWED_ORIGIN,
 *   - only accepts SlangBridge prompts (they all start with "You are SlangBridge"),
 *   - keeps model credentials on the server, never in the page,
 *   - streams the answer back as plain text (reasoning is dropped).
 *
 * Settings (Worker > Settings > Variables and Secrets / Bindings):
 *   AI              Workers AI binding                     required unless API_KEY is set
 *   ALLOWED_ORIGIN  Text, e.g. https://your-name.github.io required (comma-separate several)
 *   MODEL           Text, optional (default @cf/zai-org/glm-4.7-flash)
 *   API_KEY         Secret, optional: use an OpenAI-compatible API instead of Workers AI
 *   API_URL         Text, optional: that API's /chat/completions URL
 */

const DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";
const DEFAULT_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
const DEFAULT_API_MODEL = "glm-4-flash";
const MAX_PROMPT = 12000;
const SYSTEM = "You are a careful assistant inside the SlangBridge language-learning app. Answer with one JSON object only: no markdown, no code fences, no explanations before or after.";

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": okOrigin ? origin : "null",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { status: okOrigin ? 204 : 403, headers: cors });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, cors);
    if (!okOrigin) return json({ error: "origin_not_allowed" }, 403, cors);

    let body;
    try { body = JSON.parse(await request.text()); } catch { return json({ error: "bad_request" }, 400, cors); }
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.startsWith("You are SlangBridge") || prompt.length > MAX_PROMPT) return json({ error: "prompt_not_allowed" }, 400, cors);
    const stream = body.stream !== false;
    const messages = [{ role: "system", content: SYSTEM }, { role: "user", content: prompt }];

    try {
      return env.API_KEY ? await viaOpenAICompatible(env, messages, stream, cors) : await viaWorkersAI(env, messages, stream, cors);
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.log("SlangBridge error:", msg);
      if (/\b429\b|rate|quota|neuron|capacity|limit/i.test(msg)) return json({ error: "rate_limited" }, 429, cors);
      return json({ error: "upstream_error" }, 502, cors);
    }
  },
};

/* ---------- Workers AI ---------- */
async function viaWorkersAI(env, messages, stream, cors) {
  if (!env.AI) throw new Error("Missing the AI binding");
  const model = env.MODEL || DEFAULT_MODEL;
  const base = { messages, stream, max_tokens: 1800, temperature: 0.4 };
  let out;
  try {
    // Ask reasoning models to skip their thinking phase (faster); fall back if the option is rejected.
    out = await env.AI.run(model, { ...base, chat_template_kwargs: { enable_thinking: false } });
  } catch (e) {
    if (/\b429\b|rate|quota|neuron/i.test(String(e && e.message))) throw e;
    out = await env.AI.run(model, base);
  }
  if (stream && out instanceof ReadableStream) return textStream(out, cors);
  return new Response(contentOf(out), { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
}

/* ---------- Any OpenAI-compatible API (e.g. Zhipu, OpenAI, DeepSeek) ---------- */
async function viaOpenAICompatible(env, messages, stream, cors) {
  const r = await fetch(env.API_URL || DEFAULT_API_URL, {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ model: env.MODEL || DEFAULT_API_MODEL, messages, stream, max_tokens: 1800, temperature: 0.4 }),
  });
  if (!r.ok) throw new Error("API " + r.status + " " + (await r.text()).slice(0, 200));
  if (stream && r.body) return textStream(r.body, cors);
  return new Response(contentOf(await r.json()), { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8" } });
}

/* ---------- helpers ---------- */
function contentOf(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v.response === "string") return v.response;
  if (v.response && typeof v.response === "object") return JSON.stringify(v.response);
  const c = v.choices && v.choices[0];
  if (c && c.message && typeof c.message.content === "string") return c.message.content;
  if (v.result) return contentOf(v.result);
  return JSON.stringify(v);
}

/* Turns a server-sent-events stream into a plain-text stream of the answer only. */
function textStream(sse, cors) {
  const dec = new TextDecoder(), enc = new TextEncoder();
  let buf = "";
  const pick = (line) => {
    line = line.trim();
    if (!line.startsWith("data:")) return "";
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return "";
    try {
      const o = JSON.parse(data);
      if (typeof o.response === "string") return o.response;                // Workers AI classic format
      const d = o.choices && o.choices[0] && (o.choices[0].delta || o.choices[0].message);
      return d && typeof d.content === "string" ? d.content : "";            // OpenAI format; reasoning_content is ignored
    } catch { return ""; }
  };
  const ts = new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      const text = lines.map(pick).join("");
      if (text) ctl.enqueue(enc.encode(text));
    },
    flush(ctl) {
      const text = pick(buf + dec.decode());
      if (text) ctl.enqueue(enc.encode(text));
    },
  });
  return new Response(sse.pipeThrough(ts), { headers: { ...cors, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
