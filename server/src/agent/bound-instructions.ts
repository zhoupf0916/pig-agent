/**
 * Session-bound instruction composition.
 *
 * Precedence when both are set: **expert first, then project**.
 * Expert is the role / playbook for this turn; project is shared team context.
 * Same block is used by pig, Codex, and the cloud-stub (and prepended on remote create-run).
 */

export type BoundInstructions = {
  expertInstruction?: string;
  projectInstruction?: string;
};

export const EXPERT_INSTRUCTION_HEADING =
  "Expert instructions (role / playbook — take this role first):";

export const PROJECT_INSTRUCTION_HEADING =
  "Project instructions (shared team context — follow these for this bound session):";

export function formatBoundInstructionBlock(input: BoundInstructions): string {
  const expert = input.expertInstruction?.trim();
  const project = input.projectInstruction?.trim();
  const parts: string[] = [];
  if (expert) {
    parts.push(`${EXPERT_INSTRUCTION_HEADING}\n${expert}`);
  }
  if (project) {
    parts.push(`${PROJECT_INSTRUCTION_HEADING}\n${project}`);
  }
  return parts.join("\n\n");
}

export function prependBoundInstructions(prompt: string, input: BoundInstructions): string {
  const block = formatBoundInstructionBlock(input);
  const body = prompt.trim();
  if (!block) return body;
  if (!body) return block;
  return `${block}\n\n${body}`;
}
