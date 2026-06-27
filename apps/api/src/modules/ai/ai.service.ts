import { Injectable } from "@nestjs/common";
import { AiAction, Channel } from "@prisma/client";
import OpenAI from "openai";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AiService {
  private readonly client = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

  constructor(private readonly prisma: PrismaService) {}

  async createSuggestionForMessage(messageId: string) {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: true, customer: true },
    });
    if (!message || message.direction !== "inbound" || !message.text) return null;

    const fallback = {
      detected_language: "en",
      intent: "other",
      suggested_reply: "",
      confidence: 0,
      action: "ask_human" as const,
    };

    const materials = await this.findRelevantMaterials(message.text, message.channel);
    const suggestion = this.client ? await this.askModel(message.text, { materials }).catch(() => fallback) : this.fallbackSuggestion(message.text, materials);
    const action = this.normalizeAction(suggestion.action, suggestion.confidence);

    return this.prisma.aiReplyLog.create({
      data: {
        messageId: message.id,
        conversationId: message.conversationId,
        detectedLanguage: suggestion.detected_language,
        intent: suggestion.intent,
        suggestedReply: suggestion.suggested_reply,
        confidence: suggestion.confidence,
        action,
        rawResponse: suggestion,
      },
    });
  }

  async createSuggestionForConversation(conversationId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        customer: true,
        messages: {
          orderBy: { sentAt: "desc" },
          take: 12,
        },
      },
    });
    if (!conversation) return null;

    const messages = [...conversation.messages].reverse();
    const latestInbound = [...messages].reverse().find((message) => message.direction === "inbound" && message.text);
    const customerText = latestInbound?.text ?? messages.map((message) => message.text).filter(Boolean).join("\n").slice(-1000);
    if (!customerText) return null;

    const materials = await this.findRelevantMaterials(customerText, conversation.channel);
    const suggestion = this.client
      ? await this.askModel(customerText, {
          materials,
          conversationContext: messages.map((message) => ({
            direction: message.direction,
            text: message.text,
            sentAt: message.sentAt,
          })),
        }).catch(() => this.fallbackSuggestion(customerText, materials))
      : this.fallbackSuggestion(customerText, materials);
    const action = this.normalizeAction(suggestion.action, suggestion.confidence);

    const log = await this.prisma.aiReplyLog.create({
      data: {
        messageId: latestInbound?.id,
        conversationId,
        detectedLanguage: suggestion.detected_language ?? "unknown",
        intent: suggestion.intent ?? "other",
        suggestedReply: suggestion.suggested_reply ?? "",
        confidence: Number(suggestion.confidence ?? 0),
        action,
        rawResponse: {
          ...suggestion,
          trainingMaterialIds: materials.map((material) => material.id),
          generatedBy: "manual_ai_button",
        },
      },
    });

    if (materials.length) {
      await this.prisma.aiTrainingMaterial.updateMany({
        where: { id: { in: materials.map((material) => material.id) } },
        data: { usageCount: { increment: 1 } },
      });
    }

    return {
      ...log,
      trainingMaterialIds: materials.map((material) => material.id),
      alreadySaved: await this.hasSameTrainingAnswer(log.suggestedReply),
    };
  }

  async listTrainingMaterials() {
    return this.prisma.aiTrainingMaterial.findMany({
      where: { isActive: true },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  }

  async saveTrainingMaterial(body: any) {
    const answer = String(body.answer ?? body.finalText ?? body.suggestedReply ?? "").trim();
    if (!answer) throw new Error("answer is required");
    const question = String(body.question ?? body.customerText ?? "").trim() || "General customer question";
    const existing = await this.prisma.aiTrainingMaterial.findFirst({
      where: {
        answer: { equals: answer, mode: "insensitive" },
        isActive: true,
      },
    });
    if (existing) return { material: existing, alreadySaved: true };

    const material = await this.prisma.aiTrainingMaterial.create({
      data: {
        title: String(body.title ?? this.titleFromText(question)).slice(0, 120),
        question,
        answer,
        language: String(body.language ?? body.detectedLanguage ?? "unknown"),
        intent: String(body.intent ?? "other"),
        channel: body.channel as Channel | undefined,
        source: String(body.source ?? "agent_saved_reply"),
        conversationId: body.conversationId,
        messageId: body.messageId,
        aiReplyLogId: body.aiReplyLogId,
        metadata: body.metadata ?? {},
      },
    });

    if (body.aiReplyLogId) {
      await this.prisma.aiReplyLog.update({
        where: { id: body.aiReplyLogId },
        data: { acceptedAt: new Date(), finalText: answer },
      }).catch(() => undefined);
    }

    return { material, alreadySaved: false };
  }

  async updateTrainingMaterial(id: string, body: any) {
    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = String(body.title).trim().slice(0, 120) || "AI training material";
    if (body.question !== undefined) data.question = String(body.question).trim() || "General customer question";
    if (body.answer !== undefined) {
      const answer = String(body.answer).trim();
      if (!answer) throw new Error("answer is required");
      data.answer = answer;
    }
    if (body.language !== undefined) data.language = String(body.language).trim() || "unknown";
    if (body.intent !== undefined) data.intent = String(body.intent).trim() || "other";
    if (body.channel !== undefined) data.channel = body.channel || null;
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    if (body.metadata !== undefined) data.metadata = body.metadata ?? {};

    const material = await this.prisma.aiTrainingMaterial.update({
      where: { id },
      data,
    });
    return { material };
  }

  async deleteTrainingMaterial(id: string) {
    const material = await this.prisma.aiTrainingMaterial.delete({
      where: { id },
    });
    return { material, deleted: true };
  }

  async hasSameTrainingAnswer(answer?: string | null) {
    const value = String(answer ?? "").trim();
    if (!value) return false;
    const existing = await this.prisma.aiTrainingMaterial.findFirst({
      where: { answer: { equals: value, mode: "insensitive" }, isActive: true },
      select: { id: true },
    });
    return Boolean(existing);
  }

  private async findRelevantMaterials(text: string, channel?: Channel | null) {
    const words = this.keywords(text);
    const materials = await this.prisma.aiTrainingMaterial.findMany({
      where: {
        isActive: true,
        OR: [
          ...(channel ? [{ channel }, { channel: null }] : [{ channel: null }]),
          ...words.flatMap((word) => [
            { question: { contains: word, mode: "insensitive" as const } },
            { answer: { contains: word, mode: "insensitive" as const } },
            { title: { contains: word, mode: "insensitive" as const } },
          ]),
        ],
      },
      orderBy: [{ usageCount: "desc" }, { updatedAt: "desc" }],
      take: 8,
    });
    return materials;
  }

  private async askModel(text: string, options?: { materials?: { question: string; answer: string; intent: string; language: string }[]; conversationContext?: unknown[] }) {
    const response = await this.client!.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an assistant for CoolFix Pro Supply CRM. Return only JSON with detected_language, intent, suggested_reply, confidence, action. Never auto-send. Use the training materials when relevant, but do not copy them blindly if the customer context differs. Complaints, refunds, insults, uncertain stock, and confidence under 0.7 must use action ask_human.",
        },
        {
          role: "user",
          content: JSON.stringify({
            customer_message: text,
            conversation_context: options?.conversationContext ?? [],
            training_materials: options?.materials ?? [],
          }),
        },
      ],
    });
    return JSON.parse(response.choices[0]?.message.content ?? "{}");
  }

  private fallbackSuggestion(text: string, materials: { answer: string; language?: string; intent?: string }[]) {
    const first = materials[0];
    if (first?.answer) {
      return {
        detected_language: first.language ?? "unknown",
        intent: first.intent ?? "other",
        suggested_reply: first.answer,
        confidence: 0.72,
        action: "suggest_reply" as const,
      };
    }
    return {
      detected_language: /[\u4e00-\u9fff]/.test(text) ? "zh" : "en",
      intent: "other",
      suggested_reply: "Thanks for your message. I will check it and get back to you shortly.",
      confidence: 0.55,
      action: "ask_human" as const,
    };
  }

  private keywords(text: string) {
    return [...new Set(text.toLowerCase().match(/[a-z0-9]{3,}|[\u4e00-\u9fff]{2,}/g) ?? [])].slice(0, 8);
  }

  private titleFromText(text: string) {
    return text.replace(/\s+/g, " ").trim().slice(0, 80) || "AI training material";
  }

  private normalizeAction(action: unknown, confidence: unknown): AiAction {
    const normalized = String(action ?? "").trim().toLowerCase();
    const score = Number(confidence);
    if (normalized === "ask_human" || (Number.isFinite(score) && score < 0.7)) return AiAction.ask_human;
    if (normalized === "no_reply") return AiAction.no_reply;
    if (normalized === "suggest_reply" || normalized === "send_reply" || normalized === "reply") return AiAction.suggest_reply;
    return AiAction.ask_human;
  }
}
