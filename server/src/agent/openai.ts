import type { ChatMessage, ToolCall } from "../types.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";

export type LlmSettings = {
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
};

export type CompletionDelta = {
  content?: string;
  toolCalls?: ToolCall[];
  finishReason?: string | null;
};

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function toOpenAiMessages(
  messages: ChatMessage[],
): Array<Record<string, unknown>> {
  return messages
    .filter((m) => m.role !== "system" || m.content.trim() !== "")
    .map((m) => {
      if (m.role === "assistant" && m.toolCalls?.length) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function",
            function: { name: tc.name, arguments: tc.arguments },
          })),
        };
      }
      if (m.role === "tool") {
        return {
          role: "tool",
          tool_call_id: m.toolCallId,
          content: m.content,
        };
      }
      return { role: m.role, content: m.content };
    });
}

export async function complete(
  settings: LlmSettings,
  messages: ChatMessage[],
  options: {
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
  } = {},
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const url = `${normalizeBaseUrl(settings.llmBaseUrl)}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.llmApiKey.trim()) {
    headers.Authorization = `Bearer ${settings.llmApiKey.trim()}`;
  }

  const body = {
    model: settings.llmModel,
    messages: toOpenAiMessages(messages),
    tools: TOOL_DEFINITIONS,
    tool_choice: "auto",
    stream: true,
    temperature: 0.3,
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LlmError(
      `Cannot reach LLM at ${url}. Start Ollama or check Settings. (${msg})`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new LlmError(
      `LLM HTTP ${response.status}: ${text.slice(0, 800) || response.statusText}`,
      response.status,
    );
  }

  if (!response.body) {
    throw new LlmError("LLM returned an empty body");
  }

  return consumeStream(response.body, options.onDelta);
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();

  const flushLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(":")) return;
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (data === "[DONE]") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const choice = (parsed as { choices?: Array<Record<string, unknown>> }).choices?.[0];
    if (!choice) return;
    const delta = (choice.delta ?? choice.message ?? {}) as {
      content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = part.index ?? 0;
        const current = toolAcc.get(index) ?? { id: "", name: "", arguments: "" };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) current.arguments += part.function.arguments;
        toolAcc.set(index, current);
      }
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) flushLine(line);
  }
  if (buffer.trim()) flushLine(buffer);

  const toolCalls: ToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc], i) => ({
      id: tc.id || `call_${i}`,
      name: tc.name,
      arguments: tc.arguments || "{}",
    }))
    .filter((tc) => tc.name);

  return { content, toolCalls };
}
