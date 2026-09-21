/**
 * Isolated Codex model catalog.
 * `base_instructions` is required by modern Codex; keep this in-repo template
 * free of secrets. Real keys never belong here.
 */

const BASE_INSTRUCTIONS = `You are Codex running as an optional backend for Pig Agent, a local workstation assistant.

Stay inside the current workspace. Prefer small, reviewable file edits (apply_patch).
Do not escape the workspace. Do not ask for interactive approval; execute the task.
After changing files, write a clear user-facing summary: what changed, created vs modified vs deleted (paths), and what to review.
Reply in the user's language (Chinese if they wrote in Chinese).
`;

function deepseekModel(slug: string, displayName: string, description: string, priority: number) {
  return {
    slug,
    display_name: displayName,
    description,
    prefer_websockets: false,
    experimental_supported_tools: [],
    support_verbosity: true,
    default_verbosity: "low",
    apply_patch_tool_type: "freeform",
    web_search_tool_type: "text",
    input_modalities: ["text"],
    supports_image_detail_original: false,
    truncation_policy: { mode: "tokens", limit: 10_000 },
    supports_parallel_tool_calls: true,
    context_window: 1_048_576,
    max_context_window: 1_048_576,
    effective_context_window_percent: 95,
    default_reasoning_level: "high",
    supported_reasoning_levels: [
      { effort: "low", description: "Fast responses with lighter reasoning" },
      { effort: "high", description: "Extra high reasoning depth for complex problems" },
      { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
    ],
    shell_type: "shell_command",
    visibility: "list",
    minimal_client_version: "0.144.0",
    supported_in_api: true,
    supports_search_tool: false,
    supports_reasoning_summaries: true,
    priority,
    base_instructions: BASE_INSTRUCTIONS,
    model_messages: {
      instructions_template: BASE_INSTRUCTIONS,
      instructions_variables: {
        personality_default: "",
        personality_friendly: "",
        personality_pragmatic: "",
      },
      approvals: null,
    },
  };
}

/** Fail fast: modern Codex cannot parse catalog entries without `base_instructions`. */
export function assertModelsHaveBaseInstructions(
  catalog: unknown,
  source = "models.json",
): void {
  if (!catalog || typeof catalog !== "object" || !("models" in catalog)) {
    throw new Error(`Codex models catalog is invalid (${source}): expected a { models: [...] } object`);
  }
  const models = (catalog as { models: unknown }).models;
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error(`Codex models catalog has no model entries (${source})`);
  }
  for (const [index, entry] of models.entries()) {
    if (!entry || typeof entry !== "object") {
      throw new Error(`Codex models catalog entry #${index} is not an object (${source})`);
    }
    const model = entry as { slug?: unknown; base_instructions?: unknown };
    const label = typeof model.slug === "string" && model.slug ? model.slug : `#${index}`;
    if (typeof model.base_instructions !== "string" || !model.base_instructions.trim()) {
      throw new Error(
        `Codex model "${label}" is missing required base_instructions (${source}). Modern Codex cannot parse this catalog.`,
      );
    }
  }
}

export const CODEX_MODELS_CATALOG = {
  models: [
    deepseekModel(
      "deepseek-flash",
      "DeepSeek-Flash",
      "DeepSeek coding model via the Responses API (Codex wire_api=responses).",
      1,
    ),
    deepseekModel(
      "deepseek-v4-flash",
      "DeepSeek-V4-Flash",
      "DeepSeek V4 Flash via the Responses API.",
      2,
    ),
    deepseekModel(
      "deepseek-v4-pro",
      "DeepSeek-V4-Pro",
      "DeepSeek V4 Pro via the Responses API.",
      3,
    ),
  ],
};
