import type { ChatMessage, ToolCall } from "../types.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";

export type TokenUsage = { prompt_tokens: number; completion_tokens: number };
type CompletionOptions = { extraTools?: Array<{ type: "function"; function: { name: string; description?: string; parameters: unknown } }>; allowTools?: boolean; signal?: AbortSignal; onDelta?: (text: string) => void; onUsage?: (usage: TokenUsage) => void; maxOutputTokens?: number };

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
    readonly retryable = false,
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
          ...(m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}),
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
      return { role: m.role, content: m.content, ...(m.role === "assistant" && m.reasoningContent !== undefined ? { reasoning_content: m.reasoningContent } : {}) };
    });
}

type Attempt = {
  stream: boolean;
  parallelTools: boolean;
};

export async function complete(
  settings: LlmSettings,
  messages: ChatMessage[],
  options: CompletionOptions = {},
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const attempts: Attempt[] = [
    { stream: true, parallelTools: true },
    { stream: true, parallelTools: false },
    { stream: false, parallelTools: false },
  ];

  let lastError: LlmError | undefined;
  for (const [i, attempt] of attempts.entries()) {
    try {
      return await completeOnce(settings, messages, options, attempt);
    } catch (err) {
      if (options.signal?.aborted) {
        throw err instanceof Error ? err : new Error(String(err));
      }
      if (!(err instanceof LlmError) || !err.retryable || i === attempts.length - 1) {
        throw err;
      }
      lastError = err;
    }
  }
  throw lastError ?? new LlmError("LLM request failed");
}

async function completeOnce(
  settings: LlmSettings,
  messages: ChatMessage[],
  options: CompletionOptions,
  attempt: Attempt,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const url = `${normalizeBaseUrl(settings.llmBaseUrl)}/chat/completions`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (settings.llmApiKey.trim()) {
    headers.Authorization = `Bearer ${settings.llmApiKey.trim()}`;
  }

  const body: Record<string, unknown> = {
    model: settings.llmModel,
    messages: toOpenAiMessages(messages),
    ...(options.allowTools === false ? {} : { tools: [...TOOL_DEFINITIONS, ...(options.extraTools ?? [])], tool_choice: "auto" }),
    stream: attempt.stream,
    temperature: 0.2,
  };
  // New DeepSeek thinking turns require complete reasoning replay, including tool turns.
  // Historical transcripts without that field can safely resume in non-thinking mode.
  const providerHost = new URL(settings.llmBaseUrl).hostname;
  if (providerHost === "api.deepseek.com") {
    if (messages.some((m) => m.role === "assistant" && m.toolCalls?.length && m.reasoningContent === undefined)) body.thinking = { type: "disabled" };
    body.messages = toOpenAiMessages(messages).map((m) => m.role === "assistant" ? { ...m, reasoning_content: m.reasoning_content ?? "" } : m);
  }
  if (options.maxOutputTokens) body.max_tokens = options.maxOutputTokens;
  if (attempt.stream && attempt.parallelTools && options.onUsage) body.stream_options = { include_usage: true };
  if (attempt.parallelTools && options.allowTools !== false) {
    body.parallel_tool_calls = true;
  }

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
    if (options.signal?.aborted) throw new Error("Aborted");
    throw new LlmError(
      `Cannot reach LLM at ${url}. Check Settings or .env.local (DeepSeek / OpenAI-compatible). (${msg})`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const retryable = shouldRetryLlm(response.status, text, attempt);
    throw new LlmError(
      `LLM HTTP ${response.status}: ${text.slice(0, 800) || response.statusText}`,
      response.status,
      retryable,
    );
  }

  if (attempt.stream) {
    if (!response.body) {
      throw new LlmError("LLM returned an empty body", response.status, true);
    }
    return consumeStream(response.body, options.onDelta, options.onUsage);
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };
    }>;
  };
  const usage = (json as { usage?: TokenUsage }).usage;
  if (usage) options.onUsage?.(usage);
  return fromMessage(json.choices?.[0]?.message, options.onDelta);
}

function shouldRetryLlm(status: number, body: string, attempt: Attempt): boolean {
  if (status === 400 || status === 422) {
    const lower = body.toLowerCase();
    if (attempt.parallelTools && /parallel|tool_choice|tools|unknown/.test(lower)) {
      return true;
    }
    if (attempt.stream && /stream/.test(lower)) return true;
    return true;
  }
  return status >= 500;
}

function fromMessage(
  message:
    | {
        content?: string | null;
        reasoning_content?: string;
        tool_calls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      }
    | undefined,
  onDelta?: (text: string) => void,
): { content: string; toolCalls: ToolCall[]; reasoningContent?: string } {
  const content = typeof message?.content === "string" ? message.content : "";
  if (content) onDelta?.(content);
  const toolCalls: ToolCall[] = (message?.tool_calls ?? [])
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      name: tc.function?.name ?? "",
      arguments:
        typeof tc.function?.arguments === "string"
          ? tc.function.arguments
          : JSON.stringify(tc.function?.arguments ?? {}),
    }))
    .filter((tc) => tc.name);
  return { content, toolCalls, ...(message?.reasoning_content ? { reasoningContent: message.reasoning_content } : {}) };
}

async function consumeStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (text: string) => void,
  onUsage?: (usage: TokenUsage) => void,
): Promise<{ content: string; toolCalls: ToolCall[]; reasoningContent?: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
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
    const usage = (parsed as { usage?: TokenUsage }).usage;
    if (usage) onUsage?.(usage);
    const choice = (parsed as { choices?: Array<Record<string, unknown>> }).choices?.[0];
    if (!choice) return;
    const delta = (choice.delta ?? choice.message ?? {}) as {
      content?: string | null;
      reasoning_content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
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
        if (part.function?.arguments) {
          current.arguments +=
            typeof part.function.arguments === "string"
              ? part.function.arguments
              : JSON.stringify(part.function.arguments);
        }
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

  return { content, toolCalls, ...(reasoningContent ? { reasoningContent } : {}) };
}
