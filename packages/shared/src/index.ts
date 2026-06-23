export const CHANNELS = [
  "messenger",
  "whatsapp",
  "sms",
  "instagram",
  "email",
  "website_chat",
  "phone",
] as const;

export type Channel = (typeof CHANNELS)[number];

export type AiSuggestion = {
  detected_language: "en" | "es" | "zh";
  intent:
    | "price"
    | "stock"
    | "pickup"
    | "shipping"
    | "complaint"
    | "refund"
    | "order"
    | "other";
  suggested_reply: string;
  confidence: number;
  action: "suggest_reply" | "ask_human" | "no_reply";
};

export type InboundAttachment = {
  type: "image" | "audio" | "video" | "file";
  url: string;
  mimeType?: string;
  fileName?: string;
  sizeBytes?: number;
  externalMediaId?: string;
};

export type NormalizedInboundMessage = {
  channel: Channel;
  provider: string;
  channelAccountExternalId?: string;
  externalThreadId?: string;
  externalMessageId?: string;
  senderExternalId: string;
  senderName?: string;
  senderAvatarUrl?: string;
  phone?: string;
  email?: string;
  text?: string;
  timestamp?: string;
  attachments?: InboundAttachment[];
  rawPayload: unknown;
};
