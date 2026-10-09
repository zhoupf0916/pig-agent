export const WEBHOOK_EVENTS = ["run.succeeded", "run.failed", "run.cancelled", "approval.requested"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
export const MAX_ATTEMPTS = 8;
