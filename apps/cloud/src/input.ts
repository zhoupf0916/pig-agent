import { attachmentIdsSchema } from "./attachments.ts";
import { z } from "zod";
export const inputSchema = z.object({
  attachmentIds: attachmentIdsSchema,
  useUserDefaults: z.boolean().optional(),
  expertId: z.string().min(1).max(100).optional(),
  skillIds: z.array(z.string().min(1).max(100)).max(20).optional(),
  prompt: z.string().trim().min(1).max(32000),
  sessionId: z.string().max(100).optional(),
  projectId: z.string().regex(/^project_[a-f0-9]{32}$/).optional(),
  requireApproval: z.boolean().optional(),
  networkPolicy: z.enum(["ask", "blocked"]).default("ask"),
  files: z
    .array(
      z.object({
        path: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[^/\\]+$/)
          .refine(
            (p) =>
              !p.startsWith(".") &&
              !/[\x00-\x1f]/.test(p) &&
              !/^id_(rsa|dsa|ed25519)$/i.test(p) &&
              !/\.(pem|key|p12|pfx)$/i.test(p),
            "Sensitive filename",
          ),
        content: z.string().max(200000),
      }),
    )
    .max(20)
    .optional(),
  messages: z
    .array(
      z.object({
        id: z.string(),
        role: z.enum(["user", "assistant"]),
        content: z.string().max(80000),
        createdAt: z.string(),
      }),
    )
    .max(40)
    .default([]),
  model: z.string().max(100).optional(),
  workspace: z
    .object({
      snapshot: z
        .object({
          encoding: z.literal("tar.gz"),
          data: z.string().max(6 * 1024 * 1024),
          files: z.array(z.string()).max(400),
          skipped: z.array(z.string()).default([]),
          byteSize: z.number().max(4 * 1024 * 1024),
          truncated: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});
