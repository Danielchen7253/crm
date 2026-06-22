import { Injectable } from "@nestjs/common";
import { CallEventType, CallStatus, Channel } from "@prisma/client";
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
}
