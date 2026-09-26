// OpenAI helpers for the Setup page: design a bee from the owner's sentence (one small, cheap text call), and paint its
// portrait in the same art style as the original three (one image edit with the three portraits as references; they
// are references only and are never shown for an owner's bee). Nothing here runs outside Setup.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STYLE_INFO, STYLES, type StyleId } from "./settings.js";

const API = "https://api.openai.com/v1";

export class OpenAiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

/** OpenAI's error message only: never the request, never the key. */
async function fail(res: Response): Promise<never> {
  let msg = `HTTP ${res.status}`;
  try {
    const j = (await res.json()) as { error?: { message?: string } };
    if (j.error?.message) msg = j.error.message.slice(0, 300);
  } catch {
    /* not JSON */
  }
  throw new OpenAiError(res.status, msg);
}

/** What the model invents from the owner's sentence. Setup validates and narrows it (setup.ts, bees/custom.ts). */
export interface BeeDesign {
  name: string;
  tagline: string;
  rules: string;
  coins: string[];
  baseStyle: StyleId;
  look: string;
  /** Set when the designer asked for a brain that cannot trade these coins, so the bee runs on another one. */
  styleNote?: string;
}

/**
 * One short call: turn "how do you want this bee to trade?" into a bee. `coins` is the current OKX EEA crypto X-Perp
 * list; the model may only restrict the bee to coins on it.
 */
export async function designBee(apiKey: string, model: string, description: string, coins: string[], timeoutMs = 30_000): Promise<BeeDesign> {
  const styles = STYLES.map((s) => `- ${s} (${STYLE_INFO[s].label}): ${STYLE_INFO[s].blurb}`).join("\n");
  const reserved = STYLES.map((s) => STYLE_INFO[s].name).join(", ");
  const res = await fetch(`${API}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "You design a cartoon trading bee for a paper-trading game on OKX perpetual futures, from its owner's description. Return:\n" +
            "- name: a fun name, one or two words, max 20 characters, letters and spaces only. Never " +
            reserved +
            " or any spelling of them (they belong to the official bees).\n" +
            "- tagline: 2-5 words starting with 'the', e.g. 'the sleepy dip hunter'.\n" +
            "- rules: the bee's trading instructions in plain English, 2-4 short imperative sentences, max 450 characters. " +
            "They are read by the decision model on every tick, so be concrete: which coins, when to go long or short, when to hold, when to get out. No prices or dates.\n" +
            "- coins: tickers the bee is restricted to, only from the list below, [] if the owner wants any coin.\n" +
            "- baseStyle: the built-in engine it runs on. bizzy only if coins are all in BTC, ETH, SOL, HYPE; breezy only if coins are all in BTC, ETH; otherwise boozy.\n" +
            "- look: one or two sentences on what the bee looks like (props, outfit, mood) for its portrait. No real people's faces, no logos, no text.\n" +
            "Never give financial advice.\n\nBuilt-in engines:\n" +
            styles +
            "\n\nCoins on OKX EEA right now: " +
            coins.join(" "),
        },
        { role: "user", content: description.slice(0, 400) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "bee_design",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["name", "tagline", "rules", "coins", "baseStyle", "look"],
            properties: {
              name: { type: "string" },
              tagline: { type: "string" },
              rules: { type: "string" },
              coins: { type: "array", items: { type: "string" } },
              baseStyle: { type: "string", enum: [...STYLES] },
              look: { type: "string" },
            },
          },
        },
      },
    }),
  });
  if (!res.ok) await fail(res);
  const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const raw = j.choices?.[0]?.message?.content;
  if (!raw) throw new OpenAiError(502, "empty answer");
  const out = JSON.parse(raw) as BeeDesign;
  if (!STYLES.includes(out.baseStyle)) throw new OpenAiError(502, "unknown style in answer");
  return out;
}

const PORTRAIT_BRIEF =
  "Create a new character portrait in exactly the same art style as the reference images: a glossy 3D animated " +
  "cartoon bee with big expressive eyes, fuzzy yellow and black stripes, translucent wings, one or two character " +
  "props, dramatic rim lighting and a dark background with glowing particles, square head-and-shoulders framing. " +
  "It must be a different bee from the references, clearly part of the same family. No text, no letters, no logos.";

/**
 * Paints a portrait with the three original bees as style references. Returns PNG bytes.
 * `refDir` holds the reference portraits (the dashboard's default bee art).
 */
export async function paintBee(apiKey: string, model: string, refDir: string, name: string, look: string, timeoutMs = 180_000): Promise<Buffer> {
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", `${PORTRAIT_BRIEF}\n\nThis bee is called ${name}. What it looks like and how it behaves: ${look.slice(0, 400)}`);
  form.append("size", "1024x1024");
  form.append("quality", "medium");
  form.append("output_format", "jpeg");
  form.append("output_compression", "88");
  form.append("n", "1");
  for (const f of ["bizzy.jpg", "breezy.jpg", "boozy.jpg"]) {
    form.append("image[]", new Blob([readFileSync(join(refDir, f))], { type: "image/jpeg" }), f);
  }
  const res = await fetch(`${API}/images/edits`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) await fail(res);
  const j = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = j.data?.[0]?.b64_json;
  if (!b64) throw new OpenAiError(502, "no image in answer");
  return Buffer.from(b64, "base64");
}

/** A cheap call that proves the key works (lists models). */
export async function checkOpenAiKey(apiKey: string, timeoutMs = 10_000): Promise<void> {
  const res = await fetch(`${API}/models`, { headers: { authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) await fail(res);
}
