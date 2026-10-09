export const WEBHOOK_EVENTS = ["run.succeeded", "run.failed", "run.cancelled", "approval.requested", "alert.firing", "alert.resolved"] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];
export const MAX_ATTEMPTS = 8;
