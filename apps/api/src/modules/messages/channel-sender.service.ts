import { Injectable } from "@nestjs/common";
import { Channel, Conversation, Customer, CustomerIdentity, Message, MessageDirection, MessageStatus } from "@prisma/client";
import { CallsService } from "../calls/calls.service";
import { PrismaService } from "../prisma/prisma.service";

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

type ChannelAccountConfig = {
  token?: string;
  secret?: string;
  fromAddress?: string;
  providerAccountId?: string;
  externalPageId?: string;
  settings: Record<string, unknown>;
};

@Injectable()
export class ChannelSenderService {
  private readonly graphVersion = process.env.META_GRAPH_VERSION ?? "v25.0";

  constructor(
    private readonly calls: CallsService,
    private readonly prisma: PrismaService,
  ) {}

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
    const config = await this.resolveChannelConfig(conversation);
    const phoneNumberId = this.pickFirstNonEmpty(
      process.env.WHATSAPP_PHONE_NUMBER_ID,
      config?.providerAccountId,
      config?.externalPageId,
      this.valueFromSettings(config?.settings, "whatsapp", "phoneNumberId", "phone_number_id", "phoneId"),
      this.valueFromSettings(config?.settings, "meta", "phoneNumberId", "phone_number_id", "phoneId"),
    );
    const token = this.pickFirstNonEmpty(
      process.env.WHATSAPP_ACCESS_TOKEN,
      process.env.META_ACCESS_TOKEN,
      config?.token,
      this.valueFromSettings(config?.settings, "whatsapp", "accessToken", "token"),
      this.valueFromSettings(config?.settings, "meta", "accessToken", "token"),
    );
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

    const config = await this.resolveChannelConfig(conversation);
    const token = this.pickFirstNonEmpty(
      process.env.MESSENGER_PAGE_ACCESS_TOKEN,
      process.env.PAGE_ACCESS_TOKEN,
      process.env.META_PAGE_ACCESS_TOKEN,
      config?.token,
      this.valueFromSettings(config?.settings, "messenger", "pageAccessToken", "accessToken", "token"),
      this.valueFromSettings(config?.settings, "meta", "pageAccessToken", "accessToken", "token"),
    );
    if (!token) return this.failed("meta-messenger", "Messenger is not connected. Add MESSENGER_PAGE_ACCESS_TOKEN in Render and retry.");

    const recipientId = this.pickFirstNonEmpty(
      this.messengerRecipientId(conversation),
      await this.findLatestInboundSenderId(conversation.id, Channel.messenger),
    );
    const normalizedRecipientId = this.normalizeMetaRecipientId(recipientId);
    if (!normalizedRecipientId) return this.failed("meta-messenger", "Missing or invalid Messenger recipient id");

    const response = await fetch(`https://graph.facebook.com/${this.graphVersion}/me/messages?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: normalizedRecipientId },
        messaging_type: "RESPONSE",
        message: { text },
      }),
    });

    return this.handleMetaResponse(response, "meta-messenger");
  }

  private async sendInstagram(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const text = this.outboundText(message);
    if (!text) return this.failed("meta-instagram", "Instagram reply requires text content");

    const config = await this.resolveChannelConfig(conversation);
    const token = this.pickFirstNonEmpty(
      process.env.INSTAGRAM_ACCESS_TOKEN,
      process.env.META_ACCESS_TOKEN,
      config?.token,
      this.valueFromSettings(config?.settings, "instagram", "accessToken", "token"),
      this.valueFromSettings(config?.settings, "meta", "accessToken", "token"),
    );
    const accountId = this.pickFirstNonEmpty(
      process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID,
      process.env.INSTAGRAM_ACCOUNT_ID,
      config?.providerAccountId,
      config?.externalPageId,
      this.valueFromSettings(config?.settings, "instagram", "businessAccountId", "accountId", "instagramBusinessAccountId"),
    );
    if (!token) return this.missing("meta-instagram", "INSTAGRAM_ACCESS_TOKEN");
    if (!accountId) return this.missing("meta-instagram", "INSTAGRAM_BUSINESS_ACCOUNT_ID");

    const recipientId = this.pickFirstNonEmpty(
      this.instagramRecipientId(conversation),
      await this.findLatestInboundSenderId(conversation.id, Channel.instagram),
    );
    const normalizedRecipientId = this.normalizeMetaRecipientId(recipientId);
    if (!normalizedRecipientId) return this.failed("meta-instagram", "Missing or invalid Instagram recipient id");

    const response = await fetch(`https://graph.facebook.com/${this.graphVersion}/${accountId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: normalizedRecipientId },
        message: { text },
      }),
    });

    return this.handleMetaResponse(response, "meta-instagram");
  }

  private async sendWebsiteChat(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const text = this.outboundText(message);
    if (!text) return this.failed("website-chat", "Website chat reply requires text content");

    const config = await this.resolveChannelConfig(conversation);
    const webhookUrl = this.pickFirstNonEmpty(
      process.env.WEBSITE_CHAT_WEBHOOK_URL,
      this.valueFromSettings(config?.settings, "website_chat", "webhookUrl", "webhook_url", "endpoint", "url"),
      this.valueFromSettings(config?.settings, "websiteChat", "webhookUrl", "webhook_url", "endpoint", "url"),
      this.valueFromSettings(config?.settings, "website", "webhookUrl", "webhook_url", "endpoint", "url"),
      config?.fromAddress,
    );
    if (!webhookUrl) return this.missing("website-chat", "WEBSITE_CHAT_WEBHOOK_URL");

    const to = this.customerContactHint(conversation);
    const sessionId = this.pickFirstNonEmpty(
      to?.sessionId,
      to?.visitorId,
      conversation.externalThreadId,
      conversation.identity?.externalId,
      conversation.identity?.externalUserId,
    );
    if (!sessionId) return this.failed("website-chat", "Missing website chat recipient session id");

    const authToken = this.pickFirstNonEmpty(
      process.env.WEBSITE_CHAT_WEBHOOK_TOKEN,
      this.valueFromSettings(config?.settings, "website_chat", "webhookToken", "token"),
      this.valueFromSettings(config?.settings, "websiteChat", "webhookToken", "token"),
    );

    const response = await this.sendJson(webhookUrl, {
      provider: "website-chat",
      method: "POST",
      authToken,
      body: {
        channel: "website_chat",
        messageId: message.id,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        customerIdentityId: conversation.identityId,
        sessionId,
        visitorId: to?.visitorId ?? sessionId,
        phone: to?.phone,
        email: to?.email,
        name: to?.displayName,
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

    const config = await this.resolveChannelConfig(conversation);
    const fromAddress = this.pickFirstNonEmpty(
      process.env.RESEND_FROM,
      process.env.EMAIL_FROM_ADDRESS,
      config?.fromAddress,
      this.valueFromSettings(config?.settings, "email", "from", "fromAddress", "fromEmail"),
      "support@coolfix.com",
    );

    const subject = process.env.EMAIL_SUBJECT_PREFIX
      ? `${process.env.EMAIL_SUBJECT_PREFIX} ${conversation.customer.displayName || "CoolFix inquiry"}`
      : `Message from CoolFix Support`;

    const resendApiKey = this.pickFirstNonEmpty(
      process.env.RESEND_API_KEY,
      config?.token,
      config?.secret,
      this.valueFromSettings(config?.settings, "email", "resendApiKey", "apiKey"),
      this.valueFromSettings(config?.settings, "resend", "apiKey", "token"),
    );

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

    const webhookUrl = this.pickFirstNonEmpty(
      process.env.EMAIL_WEBHOOK_URL,
      this.valueFromSettings(config?.settings, "email", "webhookUrl", "webhook_url", "endpoint", "url"),
      this.valueFromSettings(config?.settings, "smtp", "webhookUrl", "webhook_url", "endpoint", "url"),
    );
    if (!webhookUrl) {
      return this.missing(
        "email",
        "EMAIL_WEBHOOK_URL (fallback for SMTP relay) or RESEND_API_KEY + RESEND_FROM (or EMAIL_FROM_ADDRESS)",
      );
    }

    const response = await this.sendJson(webhookUrl, {
      provider: "email-webhook",
      method: "POST",
      authToken: this.pickFirstNonEmpty(
        process.env.EMAIL_WEBHOOK_TOKEN,
        this.valueFromSettings(config?.settings, "email", "webhookToken", "token"),
        this.valueFromSettings(config?.settings, "smtp", "webhookToken", "token"),
      ),
      body: {
        channel: "email",
        messageId: message.id,
        conversationId: conversation.id,
        customerId: conversation.customerId,
        threadId: this.pickFirstNonEmpty(
          conversation.externalThreadId,
          conversation.identity?.externalId,
          conversation.identity?.externalUserId,
        ),
        from: fromAddress,
        fromName: conversation.customer.displayName ?? "CoolFix Support",
        to,
        subject,
        text,
        date: new Date().toISOString(),
      },
    });

    return this.parseWebhookResult(response, "email-webhook");
  }

  private async sendPhone(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const config = await this.resolveChannelConfig(conversation);
    const to = conversation.identity?.phone ?? conversation.customer.primaryPhone ?? conversation.externalThreadId;
    const accountSid = this.pickFirstNonEmpty(
      process.env.TWILIO_ACCOUNT_SID,
      config?.providerAccountId,
      config?.externalPageId,
      this.valueFromSettings(config?.settings, "twilio", "accountSid", "sid"),
    );
    const authToken = this.pickFirstNonEmpty(
      process.env.TWILIO_AUTH_TOKEN,
      config?.secret,
      this.valueFromSettings(config?.settings, "twilio", "authToken", "token"),
      this.valueFromSettings(config?.settings, "twilio", "apiSecret", "secret"),
    );
    const defaultFrom = this.pickFirstNonEmpty(
      process.env.TWILIO_VOICE_FROM,
      process.env.TWILIO_DEFAULT_FROM,
      process.env.TWILIO_PHONE_NUMBER,
      process.env.TWILIO_FROM_NUMBER,
      config?.fromAddress,
      this.valueFromSettings(config?.settings, "twilio", "phoneNumber", "from", "defaultFrom"),
    );
    const apiPublicUrl = process.env.API_PUBLIC_URL?.replace(/\/$/, "") ?? "https://example.com";
    const callbackUrl = process.env.TWILIO_VOICE_CALLBACK_URL || `${apiPublicUrl}/api/twilio/incoming`;
    const statusCallback = process.env.TWILIO_VOICE_STATUS_CALLBACK_URL || `${apiPublicUrl}/api/twilio/status`;

    if (!accountSid) return this.missing("twilio-voice", "TWILIO_ACCOUNT_SID");
    if (!authToken) return this.missing("twilio-voice", "TWILIO_AUTH_TOKEN");
    if (!to) return this.failed("twilio-voice", "Missing phone recipient number");
    if (!defaultFrom)
      return this.missing("twilio-voice", "TWILIO_VOICE_FROM or TWILIO_DEFAULT_FROM or TWILIO_PHONE_NUMBER or TWILIO_FROM_NUMBER");

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

  private async sendTwilioSms(conversation: ConversationWithCustomer, message: Message): Promise<DeliveryResult> {
    const text = this.outboundText(message);
    if (!text) return this.failed("twilio", "SMS reply requires text content");

    const config = await this.resolveChannelConfig(conversation);
    const accountSid = this.pickFirstNonEmpty(
      process.env.TWILIO_ACCOUNT_SID,
      config?.providerAccountId,
      config?.externalPageId,
      this.valueFromSettings(config?.settings, "twilio", "accountSid", "sid"),
    );
    const authToken = this.pickFirstNonEmpty(
      process.env.TWILIO_AUTH_TOKEN,
      config?.secret,
      this.valueFromSettings(config?.settings, "twilio", "authToken", "token"),
      this.valueFromSettings(config?.settings, "twilio", "apiSecret", "secret"),
    );
    const from = this.pickFirstNonEmpty(
      process.env.TWILIO_DEFAULT_FROM,
      process.env.TWILIO_PHONE_NUMBER,
      process.env.TWILIO_FROM_NUMBER,
      config?.fromAddress,
      this.valueFromSettings(config?.settings, "twilio", "defaultFrom", "phoneNumber", "from"),
    );
    const messagingServiceSid = this.pickFirstNonEmpty(
      process.env.TWILIO_MESSAGING_SERVICE_SID,
      this.valueFromSettings(config?.settings, "twilio", "messagingServiceSid", "messagingService"),
    );
    if (!accountSid) return this.missing("twilio", "TWILIO_ACCOUNT_SID");
    if (!authToken) return this.missing("twilio", "TWILIO_AUTH_TOKEN");
    if (!from && !messagingServiceSid) {
      return this.missing("twilio", "TWILIO_DEFAULT_FROM or TWILIO_PHONE_NUMBER or TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID");
    }

    const to = conversation.identity?.phone ?? conversation.customer.primaryPhone ?? conversation.externalThreadId;
    if (!to) return this.failed("twilio", "Missing SMS customer phone number");

    const params = new URLSearchParams({
      To: this.e164(to),
      Body: text,
    });
    if (messagingServiceSid) {
      params.set("MessagingServiceSid", messagingServiceSid);
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

  private async resolveChannelConfig(conversation: ConversationWithCustomer): Promise<ChannelAccountConfig | null> {
    try {
      const candidates = await this.prisma.channelAccount.findMany({
        where: { channel: conversation.channel, isActive: true },
        orderBy: { createdAt: "asc" },
      });
      if (!candidates.length) return null;

      const directMatch =
        conversation.channelAccountId
          ? candidates.find((item) => item.id === conversation.channelAccountId)
          : undefined;
      const directUsable = directMatch ? this.isUsableForConversationChannel(directMatch, conversation.channel) : false;
      if (directUsable) return this.normalizeChannelAccount(directMatch);

      const sorted = this.rankChannelAccountsForConversation(candidates, conversation.channel);
      return this.normalizeChannelAccount(sorted[0]);
    } catch (error) {
      console.error("Failed to resolve channel account for outbound send", {
        conversationId: conversation.id,
        channel: conversation.channel,
        error,
      });
    }

    return null;
  }

  private normalizeChannelAccount(account: {
    id?: string;
    encryptedToken?: string | null;
    encryptedSecret?: string | null;
    fromAddress?: string | null;
    providerAccountId?: string | null;
    externalPageId?: string | null;
    settings: unknown;
  }): ChannelAccountConfig {
    return {
      token: this.normalizeString(account.encryptedToken),
      secret: this.normalizeString(account.encryptedSecret),
      fromAddress: this.normalizeString(account.fromAddress),
      providerAccountId: this.normalizeString(account.providerAccountId),
      externalPageId: this.normalizeString(account.externalPageId),
      settings: this.normalizeSettings(account.settings),
    };
  }

  private isUsableForConversationChannel(account: { name?: string | null; encryptedToken?: string | null; encryptedSecret?: string | null; settings?: unknown; fromAddress?: string | null }, channel: Channel): boolean {
    const hasToken = this.normalizeString(account.encryptedToken);
    const hasSecret = this.normalizeString(account.encryptedSecret);
    if (channel === "whatsapp") return Boolean(hasSecret || hasToken);
    if (channel === "messenger" || channel === "instagram") return Boolean(hasToken || hasSecret);
    if (channel === "website_chat") return Boolean(this.valueFromSettings(this.normalizeSettings(account.settings), "website_chat", "webhookUrl", "webhook_url", "endpoint", "url"));
    if (channel === "email") return Boolean(hasToken || this.valueFromSettings(this.normalizeSettings(account.settings), "email", "webhookUrl", "webhook_url", "endpoint", "url"));
    if (channel === "sms" || channel === "phone") return Boolean(hasSecret);
    return Boolean(hasToken || hasSecret || this.normalizeString(account.fromAddress));
  }

  private rankChannelAccountsForConversation(accounts: Array<{ name?: string | null; encryptedToken?: string | null; encryptedSecret?: string | null; settings?: unknown; fromAddress?: string | null; updatedAt: Date }>, channel: Channel) {
    return [...accounts].sort((left, right) => {
      const l = this.scoreAccountForConversation(left, channel);
      const r = this.scoreAccountForConversation(right, channel);
      if (r !== l) return r - l;
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    });
  }

  private scoreAccountForConversation(account: { name?: string | null; encryptedToken?: string | null; encryptedSecret?: string | null; settings?: unknown; fromAddress?: string | null }, channel: Channel) {
    let score = 0;
    const normalizedName = (account.name ?? "").toLowerCase();
    if (normalizedName.startsWith("auto_")) score += 12;
    if (this.valueFromSettings(this.normalizeSettings(account.settings), "twilio", "accountSid", "sid")) score += 6;
    if (this.valueFromSettings(this.normalizeSettings(account.settings), "twilio", "authToken", "token")) score += 6;
    if (this.valueFromSettings(this.normalizeSettings(account.settings), "meta", "pageAccessToken", "accessToken", "token")) score += 6;
    if (this.valueFromSettings(this.normalizeSettings(account.settings), "meta", "phoneNumberId", "phone_number_id", "phoneId")) score += 6;

    if (channel === "sms" || channel === "phone") {
      if (this.normalizeString(account.encryptedSecret)) score += 8;
      if (!this.normalizeString(account.encryptedSecret)) score -= 6;
    } else if (channel === "website_chat" || channel === "email") {
      if (this.valueFromSettings(this.normalizeSettings(account.settings), "website_chat", "webhookUrl", "webhook_url", "endpoint", "url") || this.valueFromSettings(this.normalizeSettings(account.settings), "email", "webhookUrl", "webhook_url", "endpoint", "url")) score += 8;
      if (this.normalizeString(account.fromAddress)) score += 2;
      if (this.normalizeString(account.encryptedToken)) score += 6;
    } else if (channel === "whatsapp" || channel === "messenger" || channel === "instagram") {
      if (this.normalizeString(account.encryptedToken)) score += 8;
      if (this.normalizeString(account.encryptedSecret)) score += 8;
      if (normalizedName.includes("auto_")) score += 4;
    } else if (this.normalizeString(account.encryptedToken) || this.normalizeString(account.encryptedSecret)) {
      score += 5;
    }
    return score;
  }

  private normalizeString(value: unknown) {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : undefined;
  }

  private normalizeSettings(value: unknown) {
    if (!value) return {};
    if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    return {};
  }

  private valueFromSettings(settings: Record<string, unknown> | null | undefined, group: string, ...keys: string[]) {
    if (!settings) return undefined;
    for (const key of keys) {
      const value = this.normalizeString(settings[key]);
      if (value) return value;
    }

    const nested = settings[group];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      for (const key of keys) {
        const value = this.normalizeString((nested as Record<string, unknown>)[key]);
        if (value) return value;
      }
    }

    return undefined;
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

  private messengerRecipientId(conversation: ConversationWithCustomer) {
    const identity = conversation.identity ?? conversation.customer.identities?.find((item) => item.channel === Channel.messenger);
    const metadata = conversation.customer.metadata as Record<string, any> | null;
    const rawMetadata = metadata?.rawMetadata as Record<string, any> | undefined;
    const candidate = identity?.externalId ?? identity?.externalUserId ?? rawMetadata?.messenger_psid ?? conversation.externalThreadId;
    if (!candidate || candidate.startsWith("legacy:")) return null;
    return candidate;
  }

  private async findLatestInboundSenderId(conversationId: string, channel: Channel) {
    const inbound = await this.prisma.message.findFirst({
      where: {
        conversationId,
        channel,
        direction: MessageDirection.inbound,
        senderExternalId: { not: null },
      },
      orderBy: { sentAt: "desc" },
      select: { senderExternalId: true },
    });
    if (!inbound?.senderExternalId) return null;
    return inbound.senderExternalId;
  }

  private instagramRecipientId(conversation: ConversationWithCustomer) {
    const identity = conversation.identity ?? conversation.customer.identities?.find((item) => item.channel === Channel.instagram);
    const raw = identity?.rawProfile as Record<string, any> | null;
    return identity?.externalId ?? identity?.externalUserId ?? raw?.instagram_user_id ?? conversation.externalThreadId;
  }

  private outboundText(message: Message) {
    return message.text?.trim() || message.textContent?.trim() || "";
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

  private pickFirstNonEmpty(...values: Array<string | undefined | null>) {
    for (const value of values) {
      const resolved = this.normalizeString(value);
      if (resolved) return resolved;
    }
    return undefined;
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

  private normalizeMetaRecipientId(value: string | null | undefined) {
    const candidate = this.normalizeString(value);
    if (!candidate) return undefined;

    if (candidate.startsWith("legacy:")) return undefined;
    if (candidate.startsWith("m_") || candidate.startsWith("ig_")) return undefined;
    if (!/^\d{5,30}$/.test(candidate)) return undefined;

    return candidate;
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
