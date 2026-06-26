import { Injectable } from "@nestjs/common";
import { CallDirection, CallEventType, CallStatus, Channel, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class CallsService {
  constructor(private readonly prisma: PrismaService) {}

  async startInboundCall(input: { fromPhone: string; toPhone: string; twilioCallSid?: string }) {
    const phone = this.normalizePhone(input.fromPhone);
    let customer = await this.prisma.customer.findFirst({ where: { primaryPhone: phone, deletedAt: null } });
    if (!customer) {
      customer = await this.prisma.customer.create({
        data: {
          displayName: input.fromPhone,
          primaryPhone: phone,
          source: Channel.phone,
          lastContactAt: new Date(),
          phones: { create: { phone, isPrimary: true, label: "phone" } },
        },
      });
    }

    const customerPhone = await this.prisma.customerPhone.upsert({
      where: { customerId_phone: { customerId: customer.id, phone } },
      update: { isPrimary: true },
      create: { customerId: customer.id, phone, isPrimary: true, label: "phone" },
    });

    const conversation = await this.prisma.conversation.upsert({
      where: { channel_externalThreadId: { channel: Channel.phone, externalThreadId: phone } },
      update: { customerId: customer.id, lastMessageAt: new Date() },
      create: {
        customerId: customer.id,
        channel: Channel.phone,
        externalThreadId: phone,
        status: "open",
        lastMessageAt: new Date(),
      },
    });

    const call = await this.prisma.callSession.create({
      data: {
        customerId: customer.id,
        customerPhoneId: customerPhone.id,
        conversationId: conversation.id,
        twilioCallSid: input.twilioCallSid,
        fromPhone: phone,
        toPhone: this.normalizePhone(input.toPhone),
        status: CallStatus.ringing,
        events: { create: { type: CallEventType.call_started, payload: input } },
      },
    });

    return call;
  }

  async startOutboundCall(input: {
    conversationId: string;
    customerId: string;
    toPhone: string;
    fromPhone: string;
    twilioCallSid?: string;
  }) {
    const toPhone = this.normalizePhone(input.toPhone);
    const fromPhone = this.normalizePhone(input.fromPhone);
    if (!toPhone || !fromPhone) {
      throw new Error("Invalid phone number for outbound call");
    }

    const conversation = await this.prisma.conversation.findUnique({ where: { id: input.conversationId } });
    if (!conversation) throw new Error("Conversation not found for outbound call");

    const customer = await this.prisma.customer.findUnique({ where: { id: input.customerId } });
    const customerPhone = await this.prisma.customerPhone.upsert({
      where: { customerId_phone: { customerId: input.customerId, phone: toPhone } },
      update: { isPrimary: true },
      create: { customerId: input.customerId, phone: toPhone, isPrimary: true, label: "phone" },
    });

    return this.prisma.callSession.create({
      data: {
        customerId: input.customerId,
        customerPhoneId: customerPhone.id,
        conversationId: input.conversationId,
        twilioCallSid: input.twilioCallSid,
        fromPhone,
        toPhone,
        direction: CallDirection.outbound,
        status: CallStatus.ringing,
        language: customer?.language,
        metadata: {
          source: "outbound-from-crm",
          conversationChannel: conversation.channel,
          customerDisplayName: customer?.displayName ?? conversation.customerId,
          direction: "outbound",
          twilioCallSid: input.twilioCallSid,
        },
        events: { create: { type: CallEventType.call_started, payload: input } },
      },
    });
  }

  async markRealtimeConnected(callSessionId: string, payload: unknown) {
    return this.prisma.$transaction([
      this.prisma.callSession.update({
        where: { id: callSessionId },
        data: { status: CallStatus.active, answeredAt: new Date(), metadata: payload as object },
      }),
      this.prisma.callEvent.create({
        data: { callSessionId, type: CallEventType.realtime_connected, payload: payload as object },
      }),
    ]);
  }

  async updateFromTwilioStatus(body: {
    callSid?: string;
    status?: string;
    duration?: string | number;
    rawPayload: unknown;
  }) {
    const callSid = body.callSid?.trim();
    if (!callSid) {
      return { ok: false, reason: "CallSid missing", matched: false };
    }

    const call = await this.prisma.callSession.findUnique({ where: { twilioCallSid: callSid } });
    if (!call) {
      return { ok: false, reason: "Call session not found", matched: false, callSid };
    }

    const nextStatus = this.mapTwilioCallStatus(body.status);
    const durationSeconds = this.parseDurationSeconds(body.duration);
    const now = new Date();

    const transactionResult = await this.prisma.$transaction([
      this.prisma.callSession.update({
        where: { id: call.id },
        data: {
          status: nextStatus,
          answeredAt: this.shouldSetAnsweredAt(call.answeredAt, nextStatus) ? now : undefined,
          endedAt: this.shouldSetEndedAt(nextStatus) ? now : undefined,
          durationSeconds: durationSeconds ?? call.durationSeconds,
          metadata: {
            ...(typeof call.metadata === "object" && call.metadata ? (call.metadata as Record<string, unknown>) : {}),
            twilioStatus: body.status,
            twilioStatusAt: now.toISOString(),
            twilioRaw: body.rawPayload,
          } as Prisma.JsonObject,
        },
      }),
      this.prisma.callEvent.create({
        data: {
          callSessionId: call.id,
          type:
            nextStatus === CallStatus.completed || nextStatus === CallStatus.failed || nextStatus === CallStatus.missed
              ? CallEventType.call_ended
              : nextStatus === CallStatus.active
                ? CallEventType.realtime_connected
                : CallEventType.call_started,
          payload: {
            source: "twilio-status",
            callSid,
            status: body.status,
            durationSeconds,
            raw: body.rawPayload as Prisma.JsonValue,
          },
        },
      }),
    ]);

    return {
      ok: true,
      matched: true,
      callSessionId: call.id,
      status: nextStatus,
      data: transactionResult[0],
    };
  }

  async addTranscript(input: {
    callSessionId: string;
    speaker: string;
    text: string;
    language?: string;
    isFinal?: boolean;
    offsetMs?: number;
    rawEvent?: unknown;
  }) {
    return this.prisma.callTranscript.create({
      data: {
        callSessionId: input.callSessionId,
        speaker: input.speaker,
        text: input.text,
        language: input.language,
        isFinal: input.isFinal ?? false,
        offsetMs: input.offsetMs,
        rawEvent: (input.rawEvent ?? {}) as object,
      },
    });
  }

  async endCall(callSessionId: string, summary?: unknown) {
    const call = await this.prisma.callSession.findUniqueOrThrow({
      where: { id: callSessionId },
      include: { transcripts: true },
    });
    const endedAt = new Date();
    const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000));

    return this.prisma.$transaction([
      this.prisma.callSession.update({
        where: { id: callSessionId },
        data: {
          status: CallStatus.completed,
          endedAt,
          durationSeconds,
          summary: (summary ?? {}) as object,
        },
      }),
      this.prisma.callEvent.create({
        data: { callSessionId, type: CallEventType.call_ended, payload: { durationSeconds, summary: summary ?? null } as object },
      }),
    ]);
  }

  async requireHandoff(callSessionId: string, reason: string, confidence?: number) {
    return this.prisma.$transaction([
      this.prisma.callSession.update({
        where: { id: callSessionId },
        data: { status: CallStatus.handoff, handoffRequired: true, handoffReason: reason, confidence },
      }),
      this.prisma.aiCallAction.create({
        data: { callSessionId, action: "human_handoff", reason, confidence },
      }),
      this.prisma.callEvent.create({
        data: { callSessionId, type: CallEventType.human_handoff, payload: { reason, confidence } },
      }),
    ]);
  }

  private normalizePhone(phone: string) {
    const digits = phone.replace(/\D/g, "");
    return digits.length === 10 ? `1${digits}` : digits;
  }

  private parseDurationSeconds(value: string | number | undefined): number | undefined {
    if (typeof value === "undefined") return undefined;
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return Math.round(parsed);
  }

  private mapTwilioCallStatus(status?: string): CallStatus {
    const normalized = String(status ?? "").toLowerCase();
    if (!normalized) return CallStatus.ringing;

    if (normalized === "queued" || normalized === "initiated" || normalized === "ringing") return CallStatus.ringing;
    if (normalized === "in-progress" || normalized === "answered" || normalized === "bridged") return CallStatus.active;
    if (normalized === "completed") return CallStatus.completed;
    if (normalized === "no-answer" || normalized === "busy" || normalized === "canceled" || normalized === "cancelled") return CallStatus.missed;
    if (normalized === "failed") return CallStatus.failed;
    return CallStatus.active;
  }

  private shouldSetAnsweredAt(currentAnswerAt: Date | null, status: CallStatus) {
    if (currentAnswerAt) return false;
    return status === CallStatus.active;
  }

  private shouldSetEndedAt(status: CallStatus) {
    return status === CallStatus.completed || status === CallStatus.failed || status === CallStatus.missed;
  }
}
