import { Injectable } from "@nestjs/common";
import { Channel, Conversation, Customer, CustomerIdentity, Message, MessageStatus } from "@prisma/client";

type ConversationWithCustomer = Conversation & {
  customer: Customer;
  identity?: CustomerIdentity | null;
};

type DeliveryResult = {
  status: MessageStatus;
  provider: string;
  externalMessageId?: string;
  failedReason?: string;
  providerErrorCode?: string;
  providerErrorMessage?: string;
  raw?: unknown;
};

@Injectable()
export class ChannelSenderService {
  async send(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    try {
      if (conversation.channel === Channel.whatsapp) return await this.sendWhatsApp(conversation, message);
      if (conversation.channel === Channel.sms) return await this.sendTwilioSms(conversation, message);
      if (conversation.channel === Channel.messenger) return await this.sendMessenger(conversation, message);

      return {
        status: MessageStatus.queued,
        provider: "manual",
        failedReason: `No live sender adapter configured for ${conversation.channel}`,
      };
    } catch (error) {
      return {
        status: MessageStatus.failed,
        provider: this.providerForChannel(conversation.channel),
        failedReason: error instanceof Error ? error.message : "Unknown provider send error",
      };
    }
  }

  private async sendWhatsApp(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const token = process.env.WHATSAPP_ACCESS_TOKEN ?? process.env.META_ACCESS_TOKEN;
    if (!phoneNumberId) return this.missing("meta-whatsapp", "WHATSAPP_PHONE_NUMBER_ID");
    if (!token) return this.missing("meta-whatsapp", "WHATSAPP_ACCESS_TOKEN");

    const to = this.normalizeWhatsAppRecipient(conversation.identity?.phone ?? conversation.customer.primaryPhone ?? conversation.externalThreadId);
    if (!to) return this.failed("meta-whatsapp", "Missing WhatsApp customer phone number");

    const response = await fetch(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: true, body: message.text ?? "" },
      }),
    });

    return this.handleMetaResponse(response, "meta-whatsapp");
  }

  private async sendMessenger(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN ?? process.env.PAGE_ACCESS_TOKEN ?? process.env.META_PAGE_ACCESS_TOKEN;
    if (!token) return this.failed("meta-messenger", "Messenger is not connected. Add MESSENGER_PAGE_ACCESS_TOKEN in Render and retry.");

    const recipientId = conversation.identity?.externalId ?? conversation.externalThreadId;
    if (!recipientId) return this.failed("meta-messenger", "Missing Messenger recipient id");

    const response = await fetch(`https://graph.facebook.com/v25.0/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text: message.text ?? "" },
      }),
    });

    return this.handleMetaResponse(response, "meta-messenger");
  }

  private async sendTwilioSms(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_DEFAULT_FROM ?? process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid) return this.missing("twilio", "TWILIO_ACCOUNT_SID");
    if (!authToken) return this.missing("twilio", "TWILIO_AUTH_TOKEN");
    if (!from) return this.missing("twilio", "TWILIO_DEFAULT_FROM");

    const to = conversation.identity?.phone ?? conversation.customer.primaryPhone ?? conversation.externalThreadId;
    if (!to) return this.failed("twilio", "Missing SMS customer phone number");

    const params = new URLSearchParams({
      From: this.e164(from),
      To: this.e164(to),
      Body: message.text ?? "",
    });

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const raw = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        status: MessageStatus.failed,
        provider: "twilio",
        failedReason: this.errorMessage(raw, response.statusText),
        providerErrorCode: raw?.code ? String(raw.code) : String(response.status),
        providerErrorMessage: this.errorMessage(raw, response.statusText),
        raw,
      };
    }

    return {
      status: MessageStatus.sent,
      provider: "twilio",
      externalMessageId: raw.sid,
      raw,
    };
  }

  private async handleMetaResponse(response: Response, provider: string): Promise<DeliveryResult> {
    const raw = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        status: MessageStatus.failed,
        provider,
        failedReason: this.errorMessage(raw, response.statusText),
        providerErrorCode: raw?.error?.code ? String(raw.error.code) : String(response.status),
        providerErrorMessage: this.errorMessage(raw, response.statusText),
        raw,
      };
    }

    const messageId = raw.messages?.[0]?.id ?? raw.message_id ?? raw.recipient_id;
    return {
      status: MessageStatus.sent,
      provider,
      externalMessageId: messageId,
      raw,
    };
  }

  private missing(provider: string, name: string): DeliveryResult {
    return this.failed(provider, `Missing environment variable: ${name}`);
  }

  private failed(provider: string, failedReason: string): DeliveryResult {
    return { status: MessageStatus.failed, provider, failedReason };
  }

  private errorMessage(raw: any, fallback: string) {
    return raw?.error?.message ?? raw?.message ?? fallback;
  }

  private normalizeWhatsAppRecipient(value?: string | null) {
    if (!value) return undefined;
    return value.replace(/\D/g, "");
  }

  private e164(value: string) {
    const trimmed = value.trim();
    if (trimmed.startsWith("+")) return trimmed;
    const digits = trimmed.replace(/\D/g, "");
    return `+${digits}`;
  }

  private providerForChannel(channel: Channel) {
    if (channel === Channel.whatsapp) return "meta-whatsapp";
    if (channel === Channel.messenger) return "meta-messenger";
    if (channel === Channel.sms) return "twilio";
    return "manual";
  }
}
