import { Injectable } from "@nestjs/common";
import { Channel, Conversation, Customer, CustomerIdentity, Message, MessageStatus } from "@prisma/client";
import { CallsService } from "../calls/calls.service";

type ConversationWithCustomer = Conversation & {
  customer: Customer & { identities?: CustomerIdentity[] };
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
  private readonly graphVersion = process.env.META_GRAPH_VERSION ?? "v25.0";
  constructor(private readonly calls: CallsService) {}

  async send(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    try {
      if (conversation.channel === Channel.whatsapp) return await this.sendWhatsApp(conversation, message);
      if (conversation.channel === Channel.sms) return await this.sendTwilioSms(conversation, message);
      if (conversation.channel === Channel.messenger) return await this.sendMessenger(conversation, message);
      if (conversation.channel === Channel.instagram) return await this.sendInstagram(conversation, message);
      if (conversation.channel === Channel.website_chat) return await this.sendWebsiteChat(conversation, message);
      if (conversation.channel === Channel.email) return await this.sendEmail(conversation, message);
      if (conversation.channel === Channel.phone) return await this.sendPhone(conversation, message);

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

    const text = this.outboundText(message);
    if (!text) return this.failed("meta-whatsapp", "WhatsApp reply requires text content");

    const to = this.normalizeWhatsAppRecipient(conversation.identity?.phone ?? conversation.customer.primaryPhone ?? conversation.externalThreadId);
    if (!to) return this.failed("meta-whatsapp", "Missing WhatsApp customer phone number");

    const response = await fetch(`https://graph.facebook.com/${this.graphVersion}/${phoneNumberId}/messages`, {
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
        text: { preview_url: true, body: text },
      }),
    });

    return this.handleMetaResponse(response, "meta-whatsapp");
  }

  private async sendMessenger(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const text = this.outboundText(message);
    if (!text) return this.failed("meta-messenger", "Messenger reply requires text content");

    const token = process.env.MESSENGER_PAGE_ACCESS_TOKEN ?? process.env.PAGE_ACCESS_TOKEN ?? process.env.META_PAGE_ACCESS_TOKEN;
    if (!token) return this.failed("meta-messenger", "Messenger is not connected. Add MESSENGER_PAGE_ACCESS_TOKEN in Render and retry.");

    const recipientId = this.messengerRecipientId(conversation);
    if (!recipientId) return this.failed("meta-messenger", "Missing Messenger recipient id");

    const response = await fetch(`https://graph.facebook.com/${this.graphVersion}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    });

    return this.handleMetaResponse(response, "meta-messenger");
  }

  private async sendInstagram(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const text = this.outboundText(message);
    if (!text) return this.failed("meta-instagram", "Instagram reply requires text content");

    const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? process.env.META_ACCESS_TOKEN;
    const accountId = process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID ?? process.env.INSTAGRAM_ACCOUNT_ID;
    if (!token) return this.missing("meta-instagram", "INSTAGRAM_ACCESS_TOKEN");
    if (!accountId) return this.missing("meta-instagram", "INSTAGRAM_BUSINESS_ACCOUNT_ID");

    const recipientId = this.instagramRecipientId(conversation);
    if (!recipientId) return this.failed("meta-instagram", "Missing Instagram recipient id");

    const response = await fetch(`https://graph.facebook.com/${this.graphVersion}/${accountId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });

    return this.handleMetaResponse(response, "meta-instagram");
  }

  private async sendWebsiteChat(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const text = this.outboundText(message);
    if (!text) return this.failed("website-chat", "Website chat reply requires text content");

    const webhookUrl = process.env.WEBSITE_CHAT_WEBHOOK_URL;
    if (!webhookUrl) return this.missing("website-chat", "WEBSITE_CHAT_WEBHOOK_URL");

    const to = this.customerContactHint(conversation);
    const response = await this.sendJson(webhookUrl, {
      provider: "website-chat",
      method: "POST",
      authToken: process.env.WEBSITE_CHAT_WEBHOOK_TOKEN,
      body: {
        channel: "website_chat",
        messageId: message.id,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        customerIdentityId: conversation.identityId,
        text,
        sender: "agent",
        to,
        replyTo: to?.sessionId ?? conversation.externalThreadId,
        toPhone: to?.phone,
        toEmail: to?.email,
      },
    });

    return this.parseWebhookResult(response, "website-chat");
  }

  private async sendEmail(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const text = this.outboundText(message);
    const to = conversation.identity?.email ?? conversation.customer.primaryEmail;
    if (!to) return this.failed("email", "Missing email recipient address");
    if (!text) return this.failed("email", "Email sender requires text content");
    const fromAddress = process.env.RESEND_FROM || process.env.EMAIL_FROM_ADDRESS;

    const subject = process.env.EMAIL_SUBJECT_PREFIX
      ? `${process.env.EMAIL_SUBJECT_PREFIX} ${conversation.customer.displayName || "CoolFix inquiry"}`
      : `Message from CoolFix Support`;

    const resendApiKey = process.env.RESEND_API_KEY;
    if (resendApiKey && fromAddress) {
      const response = await this.sendJson(`https://api.resend.com/emails`, {
        provider: "resend",
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
          body: {
            from: fromAddress,
            to: [to],
            subject,
            text,
        },
      });
      return this.parseWebhookResult(response, "resend");
    }

    const webhookUrl = process.env.EMAIL_WEBHOOK_URL;
    if (!webhookUrl) {
      return this.missing(
        "email",
        "EMAIL_WEBHOOK_URL (fallback for SMTP relay) or RESEND_API_KEY + RESEND_FROM (or EMAIL_FROM_ADDRESS)",
      );
    }

    const response = await this.sendJson(webhookUrl, {
      provider: "email-webhook",
      method: "POST",
      authToken: process.env.EMAIL_WEBHOOK_TOKEN,
      body: {
        channel: "email",
        messageId: message.id,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        to,
        subject,
        text,
      },
    });

    return this.parseWebhookResult(response, "email-webhook");
  }

  private async sendPhone(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const to = conversation.identity?.phone ?? conversation.customer.primaryPhone ?? conversation.externalThreadId;
    const defaultFrom = process.env.TWILIO_VOICE_FROM || process.env.TWILIO_DEFAULT_FROM || process.env.TWILIO_PHONE_NUMBER;
    const apiPublicUrl = process.env.API_PUBLIC_URL?.replace(/\/$/, "") ?? "https://example.com";
    const callbackUrl = process.env.TWILIO_VOICE_CALLBACK_URL || `${apiPublicUrl}/api/twilio/incoming`;
    const statusCallback = process.env.TWILIO_VOICE_STATUS_CALLBACK_URL || `${apiPublicUrl}/api/twilio/status`;

    if (!accountSid) return this.missing("twilio-voice", "TWILIO_ACCOUNT_SID");
    if (!authToken) return this.missing("twilio-voice", "TWILIO_AUTH_TOKEN");
    if (!to) return this.failed("twilio-voice", "Missing phone recipient number");
    if (!defaultFrom) return this.missing("twilio-voice", "TWILIO_VOICE_FROM or TWILIO_DEFAULT_FROM or TWILIO_PHONE_NUMBER");

    const params = new URLSearchParams({
      To: this.e164(to),
      From: this.e164(defaultFrom),
      Url: callbackUrl,
      Method: "POST",
    });
    if (statusCallback) params.set("StatusCallback", statusCallback);

    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Calls.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params,
    });

    const raw = await response.json().catch(() => ({}));
    let rawWithMetadata = raw;
    if (response.ok && raw?.sid) {
      const callSession = await this.calls.startOutboundCall({
        conversationId: conversation.id,
        customerId: conversation.customerId,
        toPhone: to,
        fromPhone: defaultFrom,
        twilioCallSid: raw.sid,
      }).catch((error) => {
        console.error("Failed to persist outbound call session", error);
      });

      if (callSession) {
        rawWithMetadata = { ...rawWithMetadata, crm_call_session_id: callSession.id, crm_call_sid: raw.sid };
      }
    }

    return this.mapProviderResult(response.status, "twilio-voice", rawWithMetadata);
  }

  private messengerRecipientId(conversation: ConversationWithCustomer) {
    const identity = conversation.identity ?? conversation.customer.identities?.find((item) => item.channel === Channel.messenger);
    const metadata = conversation.customer.metadata as Record<string, any> | null;
    const rawMetadata = metadata?.rawMetadata as Record<string, any> | undefined;
    const candidate = identity?.externalId ?? identity?.externalUserId ?? rawMetadata?.messenger_psid ?? conversation.externalThreadId;
    if (!candidate || candidate.startsWith("legacy:")) return null;
    return candidate;
  }

  private outboundText(message: Message) {
    return message.text?.trim() || message.textContent?.trim() || "";
  }

  private async sendTwilioSms(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const text = this.outboundText(message);
    if (!text) return this.failed("twilio", "SMS reply requires text content");

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const from = process.env.TWILIO_DEFAULT_FROM ?? process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid) return this.missing("twilio", "TWILIO_ACCOUNT_SID");
    if (!authToken) return this.missing("twilio", "TWILIO_AUTH_TOKEN");
    if (!from && !process.env.TWILIO_MESSAGING_SERVICE_SID) return this.missing("twilio", "TWILIO_DEFAULT_FROM or TWILIO_MESSAGING_SERVICE_SID");

    const to = conversation.identity?.phone ?? conversation.customer.primaryPhone ?? conversation.externalThreadId;
    if (!to) return this.failed("twilio", "Missing SMS customer phone number");

    const params = new URLSearchParams({
      To: this.e164(to),
      Body: text,
    });
    if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
      params.set("MessagingServiceSid", process.env.TWILIO_MESSAGING_SERVICE_SID);
    } else {
      params.set("From", this.e164(from as string));
    }
    const apiPublicUrl = process.env.API_PUBLIC_URL?.replace(/\/$/, "");
    const statusCallback = process.env.TWILIO_SMS_STATUS_CALLBACK_URL || (apiPublicUrl ? `${apiPublicUrl}/api/webhooks/twilio/status` : undefined);
    if (statusCallback) {
      params.set("StatusCallback", statusCallback);
      params.set("StatusCallbackMethod", "POST");
    }

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

  private async sendJson(
    url: string,
    options: {
      provider: string;
      method?: string;
      authToken?: string;
      headers?: Record<string, string>;
      body: unknown;
    },
  ): Promise<{ response: Response; raw: unknown; provider: string }> {
    const headers = options.headers ?? {};
    if (options.authToken) headers.Authorization = `Bearer ${options.authToken}`;
    headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
    const response = await fetch(url, {
      method: options.method ?? "POST",
      headers,
      body: JSON.stringify(options.body),
    });
    const raw = await response.json().catch(() => ({}));
    return { response, raw, provider: options.provider };
  }

  private parseWebhookResult(
    data: { response: Response; raw: unknown; provider: string },
    provider: string,
  ): Promise<DeliveryResult> {
    return Promise.resolve(this.mapProviderResult(data.response.status, provider, data.raw));
  }

  private async handleMetaResponse(response: Response, provider: string): Promise<DeliveryResult> {
    const raw = await response.json().catch(() => ({}));
    return this.mapProviderResult(response.status, provider, raw);
  }

  private mapProviderResult(status: number, provider: string, raw: unknown): DeliveryResult {
    if (status >= 400) {
      return {
        status: MessageStatus.failed,
        provider,
        failedReason: this.errorMessage(raw, "provider error"),
        providerErrorCode: (raw as any)?.error?.code ? String((raw as any).error.code) : String(status),
        providerErrorMessage: this.errorMessage(raw, "provider error"),
        raw,
      };
    }

    const messageId =
      (raw as any)?.messages?.[0]?.id ??
      (raw as any)?.message_id ??
      (raw as any)?.id ??
      (raw as any)?.sid ??
      (raw as any)?.recipient_id ??
      (raw as any)?.data?.message_id;
    return {
      status: MessageStatus.sent,
      provider,
      externalMessageId: messageId,
      raw,
    };
  }

  private instagramRecipientId(conversation: ConversationWithCustomer) {
    const identity = conversation.identity ?? conversation.customer.identities?.find((item) => item.channel === Channel.instagram);
    const raw = identity?.rawProfile as Record<string, any> | null;
    return identity?.externalId ?? identity?.externalUserId ?? raw?.instagram_user_id ?? conversation.externalThreadId;
  }

  private customerContactHint(conversation: ConversationWithCustomer) {
    const firstIdentity = conversation.identity ?? conversation.customer.identities?.[0];
    if (!firstIdentity) return null;
    return {
      sessionId: firstIdentity.externalId,
      visitorId: firstIdentity.externalUserId,
      phone: firstIdentity.phone,
      email: firstIdentity.email,
      displayName: firstIdentity.displayName,
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
    if (channel === Channel.instagram) return "meta-instagram";
    if (channel === Channel.website_chat) return "website-chat";
    if (channel === Channel.email) return "email";
    if (channel === Channel.phone) return "twilio-voice";
    if (channel === Channel.sms) return "twilio";
    return "manual";
  }
}
