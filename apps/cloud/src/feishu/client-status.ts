export type FeishuStatus = { enabled: boolean; connected: boolean; botName?: string; lastEventAt?: string; lastError?: string };
export const feishuStatus: FeishuStatus = { enabled: false, connected: false };
