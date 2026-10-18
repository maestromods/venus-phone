// Structured-output calls to Gemini or a configurable OpenAI-compatible endpoint, shaped like the
// game's own adapters: Gemini gets responseJsonSchema + thinkingConfig + safety off; chat
// completions get a json_schema response_format.

import type { TextingRequest } from "./texting/prompt.js";

// Keep the historical "openrouter" identifier so saved compatible-provider settings still load.
export type Provider = "gemini" | "openrouter";
export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface LlmSettings {
  provider: Provider;
  model: string;
  apiKey: string;
  thinking: ThinkingLevel;
  /** OpenAI-compatible base URL; OpenRouter by default. */
  endpointUrl: string;
}

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const MAX_OUTPUT_TOKENS = 16384;
const TIMEOUT_MS = 180_000;

const SAFETY_OFF = [
  "HARM_CATEGORY_HARASSMENT",
  "HARM_CATEGORY_HATE_SPEECH",
  "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  "HARM_CATEGORY_DANGEROUS_CONTENT",
].map((category) => ({ category, threshold: "BLOCK_NONE" }));

export class LlmError extends Error {}

export async function completeStructured(settings: LlmSettings, request: TextingRequest, signal?: AbortSignal): Promise<unknown> {
  if (!settings.apiKey) throw new LlmError("No API key is set. Add one in Settings.");
  if (!settings.model.trim()) throw new LlmError("No model is set. Choose one in Settings.");
  const text = settings.provider === "gemini" ? await callGemini(settings, request, signal) : await callChat(settings, request, signal);
  return parseJson(text);
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new LlmError(`Could not reach the AI service: ${(err as Error).message}`);
  }
  const raw = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new LlmError(`The AI service answered HTTP ${response.status} with something that is not JSON.`);
  }
  if (!response.ok) {
    const envelope = (parsed as { error?: { message?: string } }).error;
    const detail = envelope?.message ?? "no details";
    if (/video|youtube/i.test(detail)) {
      throw new LlmError(`The AI service could not read this YouTube video (${detail}). Use a public video and a video-capable Gemini model in Settings.`);
    }
    if (/image|vision|multimodal|modalit/i.test(detail)) {
      throw new LlmError(`This model can't look at photos (${detail}). Pick a vision model in Settings.`);
    }
    throw new LlmError(`The AI service rejected the request (HTTP ${response.status}): ${detail}`);
  }
  return parsed;
}

async function callGemini(settings: LlmSettings, request: TextingRequest, signal?: AbortSignal): Promise<string> {
  const url = `${GEMINI_BASE}/models/${encodeURIComponent(settings.model)}:generateContent`;
  const parsed = (await post(
    url,
    { "x-goog-api-key": settings.apiKey },
    {
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      // Text first, images after, as the game sends them.
      contents: [
        {
          role: "user",
          parts: [
            { text: request.user },
            ...(request.images ?? []).map((image) => ({ inlineData: { mimeType: image.mimeType, data: image.data } })),
            ...(request.videos ?? []).map((url) => ({ fileData: { fileUri: url } })),
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        responseJsonSchema: request.schema.schema,
        thinkingConfig: { thinkingLevel: settings.thinking },
      },
      safetySettings: SAFETY_OFF,
    },
    signal,
  )) as GeminiResponse;
  if (parsed.promptFeedback?.blockReason) {
    throw new LlmError(`Gemini blocked the request (${parsed.promptFeedback.blockReason}).`);
  }
  const candidate = parsed.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && finish !== "STOP") throw new LlmError(`Gemini stopped early (${finish}).`);
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => !part.thought)
    .map((part) => part.text ?? "")
    .join("");
  if (!text.trim()) throw new LlmError("Gemini returned an empty reply.");
  return text;
}

interface GeminiResponse {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>;
}

async function callChat(settings: LlmSettings, request: TextingRequest, signal?: AbortSignal): Promise<string> {
  const base = settings.endpointUrl.replace(/\/+$/, "");
  const parsed = (await post(
    `${base}/chat/completions`,
    { Authorization: `Bearer ${settings.apiKey}` },
    {
      model: settings.model,
      // YouTube URLs are supported by Google's AI Studio endpoint, not Vertex.
      ...(request.videos?.length ? { provider: { only: ["Google AI Studio"], allow_fallbacks: false } } : {}),
      messages: [
        ...(request.system ? [{ role: "system", content: request.system }] : []),
        {
          role: "user",
          content: request.images?.length || request.videos?.length
            ? [
                { type: "text", text: request.user },
                ...(request.images ?? []).map((image) => ({
                  type: "image_url",
                  image_url: { url: `data:${image.mimeType};base64,${image.data}` },
                })),
                ...(request.videos ?? []).map((url) => ({ type: "video_url", video_url: { url } })),
              ]
            : request.user,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: request.schema.name, schema: request.schema.schema, strict: false },
      },
      reasoning_effort: settings.thinking === "minimal" ? "low" : settings.thinking,
      max_tokens: MAX_OUTPUT_TOKENS,
    },
    signal,
  )) as ChatResponse;
  if (parsed.error) throw new LlmError(`The AI service reported an error: ${parsed.error.message ?? "unknown"}`);
  const choice = parsed.choices?.[0];
  if (choice?.message?.refusal) throw new LlmError(`The model refused: ${choice.message.refusal}`);
  if (choice?.finish_reason === "length") throw new LlmError("The model ran out of room before finishing.");
  const content = choice?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => c.text ?? "").join("") : "";
  if (!text.trim()) throw new LlmError("The model returned an empty reply.");
  return text;
}

interface ChatResponse {
  error?: { message?: string };
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | Array<{ text?: string }>; refusal?: string };
  }>;
}

/** JSON out of a reply that may be wrapped in a code fence. */
function parseJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new LlmError("The model's reply was not valid JSON.");
  }
}
