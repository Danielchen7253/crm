import { Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { Injectable } from "@nestjs/common";
import { Channel, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

type ChannelAccountPlan = {
  name: string;
  channel: Channel;
  providerAccountId?: string;
  externalPageId?: string;
  fromAddress?: string;
  encryptedToken?: string;
  encryptedSecret?: string;
  settings?: Record<string, unknown>;
};

@Injectable()
export class ChannelAccountsBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(ChannelAccountsBootstrapService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    if (process.env.DISABLE_CHANNEL_ACCOUNTS_BOOTSTRAP === "1") {
      this.logger.log("Channel account bootstrap is disabled by DISABLE_CHANNEL_ACCOUNTS_BOOTSTRAP=1");
      return;
    }

    try {
      const plan = this.buildPlanFromEnv();
      if (!plan.length) return;
      for (const account of plan) {
        await this.upsertChannelAccount(account);
      }
      this.logger.log(`Channel account bootstrap complete: ${plan.length} account(s) synced.`);
    } catch (error) {
      this.logger.warn(`Channel account bootstrap failed: ${(error as Error)?.message ?? "unknown"}`);
    }
  }

  private async upsertChannelAccount(account: ChannelAccountPlan) {
    const existing = await this.prisma.channelAccount.findFirst({
      where: { channel: account.channel, name: account.name },
      orderBy: { createdAt: "desc" },
    });

    const payload = {
      channel: account.channel,
      name: account.name,
      providerAccountId: account.providerAccountId ?? null,
      externalPageId: account.externalPageId ?? null,
      fromAddress: account.fromAddress ?? null,
      encryptedToken: account.encryptedToken ?? null,
      encryptedSecret: account.encryptedSecret ?? null,
      settings: (account.settings ?? {}) as Prisma.InputJsonValue,
      isActive: true,
    };

    if (existing) {
      await this.prisma.channelAccount.update({
        where: { id: existing.id },
        data: payload,
      });
      return;
    }

    await this.prisma.channelAccount.create({ data: payload });
  }

  private buildPlanFromEnv(): ChannelAccountPlan[] {
    const env = process.env;
    const plans: ChannelAccountPlan[] = [];
    const apiBase = this.trim(env.API_PUBLIC_URL) || this.trim(env.PUBLIC_APP_URL);

    const twilioSid = this.trim(env.TWILIO_ACCOUNT_SID);
    const twilioAuth = this.trim(env.TWILIO_AUTH_TOKEN);
    if (twilioSid && twilioAuth) {
      const twilioDefaultFrom =
        this.trim(env.TWILIO_DEFAULT_FROM) ?? this.trim(env.TWILIO_PHONE_NUMBER) ?? this.trim(env.TWILIO_VOICE_FROM) ?? this.trim(env.TWILIO_FROM_NUMBER);
      const twilioMessagingServiceSid = this.trim(env.TWILIO_MESSAGING_SERVICE_SID);

      plans.push({
        name: "AUTO_TWILIO_SMS",
        channel: Channel.sms,
        providerAccountId: twilioSid,
        externalPageId: twilioDefaultFrom,
        fromAddress: twilioDefaultFrom,
        encryptedSecret: twilioAuth,
        settings: {
          messagingServiceSid: twilioMessagingServiceSid ?? "",
          fromAddress: twilioDefaultFrom ?? "",
          accountId: twilioSid,
        },
      });

      plans.push({
        name: "AUTO_TWILIO_VOICE",
        channel: Channel.phone,
        providerAccountId: twilioSid,
        externalPageId: twilioDefaultFrom,
        fromAddress: this.trim(env.TWILIO_VOICE_FROM) ?? twilioDefaultFrom,
        encryptedSecret: twilioAuth,
        settings: {
          accountSid: twilioSid,
          voiceCallbackUrl: this.trim(env.TWILIO_VOICE_CALLBACK_URL) ?? "",
          voiceStatusCallbackUrl: this.trim(env.TWILIO_VOICE_STATUS_CALLBACK_URL) ?? "",
        },
      });
    }

    const whatsappAccessToken = this.trim(env.WHATSAPP_ACCESS_TOKEN) || this.trim(env.META_ACCESS_TOKEN);
    const whatsappPhoneId = this.trim(env.WHATSAPP_PHONE_NUMBER_ID);
    if (whatsappAccessToken && whatsappPhoneId) {
      plans.push({
        name: "AUTO_WHATSAPP",
        channel: Channel.whatsapp,
        providerAccountId: whatsappPhoneId,
        externalPageId: whatsappPhoneId,
        encryptedToken: whatsappAccessToken,
        settings: { phoneNumberId: whatsappPhoneId },
      });
    }

    const messengerToken = this.trim(env.MESSENGER_PAGE_ACCESS_TOKEN) || this.trim(env.PAGE_ACCESS_TOKEN) || this.trim(env.META_PAGE_ACCESS_TOKEN);
    const messengerPageId = this.trim(env.MESSENGER_PAGE_ID);
    if (messengerToken) {
      plans.push({
        name: "AUTO_MESSENGER",
        channel: Channel.messenger,
        providerAccountId: messengerPageId,
        externalPageId: messengerPageId,
        encryptedToken: messengerToken,
        settings: {
          pageAccessToken: messengerToken,
          pageId: messengerPageId ?? "",
        },
      });
    }

    const instagramToken = this.trim(env.INSTAGRAM_ACCESS_TOKEN) || this.trim(env.META_ACCESS_TOKEN);
    const instagramBusinessId = this.trim(env.INSTAGRAM_BUSINESS_ACCOUNT_ID) || this.trim(env.INSTAGRAM_ACCOUNT_ID);
    if (instagramToken && instagramBusinessId) {
      plans.push({
        name: "AUTO_INSTAGRAM",
        channel: Channel.instagram,
        providerAccountId: instagramBusinessId,
        externalPageId: instagramBusinessId,
        encryptedToken: instagramToken,
        settings: { businessAccountId: instagramBusinessId },
      });
    }

    const websiteChatWebhook = this.trim(env.WEBSITE_CHAT_WEBHOOK_URL);
    if (websiteChatWebhook && !this.isSelfCallbackWebhook(websiteChatWebhook, "/api/webhooks/website-chat", apiBase)) {
      plans.push({
        name: "AUTO_WEBSITE_CHAT",
        channel: Channel.website_chat,
        providerAccountId: undefined,
        externalPageId: undefined,
        fromAddress: websiteChatWebhook,
        settings: {
          webhookUrl: websiteChatWebhook,
          webhookToken: this.trim(env.WEBSITE_CHAT_WEBHOOK_TOKEN) ?? "",
        },
      });
    }

    const resendApiKey = this.trim(env.RESEND_API_KEY);
    const resendFrom = this.trim(env.RESEND_FROM) || this.trim(env.EMAIL_FROM_ADDRESS);
    const emailWebhook = this.trim(env.EMAIL_WEBHOOK_URL);
    if (resendApiKey && resendFrom) {
      plans.push({
        name: "AUTO_EMAIL_RESEND",
        channel: Channel.email,
        fromAddress: resendFrom,
        providerAccountId: undefined,
        externalPageId: undefined,
        encryptedToken: resendApiKey,
      });
    } else if (emailWebhook) {
      if (!this.isSelfCallbackWebhook(emailWebhook, "/api/webhooks/email", apiBase)) {
        plans.push({
          name: "AUTO_EMAIL_WEBHOOK",
          channel: Channel.email,
          providerAccountId: undefined,
          externalPageId: undefined,
          settings: {
            webhookUrl: emailWebhook,
            webhookToken: this.trim(env.EMAIL_WEBHOOK_TOKEN) ?? "",
          },
        });
      }
    }

    return plans;
  }

  private trim(value?: string) {
    if (!value) return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed === "__PLACEHOLDER__") return undefined;
    return trimmed;
  }

  private isSelfCallbackWebhook(url: string, expectedPath: string, apiBase?: string) {
    if (!url || !expectedPath) return false;

    const normalizedExpectedPath = this.normalizeCallbackPath(expectedPath);
    if (!normalizedExpectedPath) return false;

    const normalizedFromUrl = this.normalizeCallbackPath(url);
    if (normalizedFromUrl && (normalizedFromUrl === normalizedExpectedPath || normalizedFromUrl === `/api${normalizedExpectedPath}`)) {
      return true;
    }

    if (!apiBase) return false;

    try {
      const parsed = new URL(url);
      const parsedApi = new URL(apiBase);
      const normalized = parsed.pathname.replace(/\/+$/, "").toLowerCase();
      return parsed.host === parsedApi.host && (normalized === normalizedExpectedPath || normalized === `/api${normalizedExpectedPath}`);
    } catch {
      return false;
    }
  }

  private normalizeCallbackPath(value?: string | null) {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (!normalized.startsWith("/")) return undefined;
    return normalized.replace(/\/+$/, "");
  }
}
