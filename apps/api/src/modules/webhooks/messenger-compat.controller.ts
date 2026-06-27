import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from "@nestjs/common";
import type { InboundAttachment, NormalizedInboundMessage } from "@coolfix-crm/shared";
import { IngestService } from "../inbox/ingest.service";

@Controller()
export class MessengerCompatController {
  constructor(private readonly ingest: IngestService) {}

  @Get("messenger")
  @HttpCode(HttpStatus.OK)
  verifyMessenger(@Query() query: Record<string, unknown>) {
    const { mode, token, challenge } = this.resolveMetaChallenge(query);
    if (mode === "subscribe" && token === this.resolveMetaVerifyToken()) {
      return challenge;
    }
    return "invalid";
  }

  @Post("messenger")
  @HttpCode(HttpStatus.OK)
  async ingestMessenger(@Body() body: any) {
    const messages = await this.normalizeMetaMessages(body);
    for (const message of messages) {
      await this.ingest.ingestInbound(message);
    }
    return { ok: true, channel: "messenger", count: messages.length };
  }

  private resolveMetaVerifyToken() {
    return (
      process.env.META_VERIFY_TOKEN ||
      process.env.META_WEBHOOK_VERIFY_TOKEN ||
      process.env.META_VERIFY ||
      process.env.WEBHOOK_VERIFY_TOKEN ||
      process.env.WEB_ORIGIN_VERIFY_TOKEN ||
      process.env.VERIFY_TOKEN
    );
  }

  private resolveMetaChallenge(query: Record<string, unknown> | undefined) {
    const readQueryValue = (name: string): string | undefined => {
      const direct = query?.[name];
      if (typeof direct === "string" || typeof direct === "number") return String(direct);
      const nested = name.split(".").reduce((cursor: unknown, key) => {
        if (cursor && typeof cursor === "object" && Object.prototype.hasOwnProperty.call(cursor, key)) {
          return (cursor as Record<string, unknown>)[key];
        }
        return undefined;
      }, query as unknown);
      if (typeof nested === "string" || typeof nested === "number") return String(nested);
      return undefined;
    };

    return {
      mode: readQueryValue("hub.mode") ?? readQueryValue("mode"),
      token: readQueryValue("hub.verify_token") ?? readQueryValue("verify_token") ?? readQueryValue("token"),
      challenge: readQueryValue("hub.challenge") ?? readQueryValue("challenge"),
    };
  }

  private async normalizeMetaMessages(body: any): Promise<NormalizedInboundMessage[]> {
    const entries = body.entry ?? [];
    const normalized: NormalizedInboundMessage[] = [];

    for (const entry of entries) {
      for (const event of entry.messaging ?? []) {
        if (!event.message) continue;
        if (event.message.is_echo) continue;

        const senderId = event.sender?.id;
        if (!senderId) continue;

        normalized.push({
          channel: "messenger",
          provider: "messenger",
          channelAccountExternalId: event.recipient?.id,
          externalThreadId: senderId,
          externalMessageId: event.message.mid,
          senderExternalId: senderId,
          text: event.message.text,
          timestamp: this.parseTimestamp(event.timestamp)?.toISOString(),
          attachments: this.normalizeAttachments(event.message.attachments),
          rawPayload: event,
        });
      }
    }

    return normalized;
  }

  private normalizeAttachments(attachments: unknown): InboundAttachment[] {
    if (!Array.isArray(attachments)) return [];
    return attachments
      .map((attachment) => {
        if (!attachment || typeof attachment !== "object") return undefined;
        const typed = attachment as Record<string, unknown>;
        const type = typed.type === "image" ? "image" : typed.type === "audio" ? "audio" : typed.type === "video" ? "video" : "file";
        const url = (typed.payload as Record<string, unknown> | undefined)?.url as string | undefined;
        if (!url || typeof url !== "string") return undefined;
        return {
          type,
          url,
          externalMediaId: (typed.payload as Record<string, unknown> | undefined)?.id as string | undefined,
        };
      })
      .filter((value): value is InboundAttachment => Boolean(value));
  }

  private parseTimestamp(value?: string | number) {
    if (!value && value !== 0) return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return undefined;
    const isSeconds = numeric < 1_000_000_000_000;
    return new Date(isSeconds ? numeric * 1000 : numeric);
  }
}
