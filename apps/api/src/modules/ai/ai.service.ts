import { Injectable } from "@nestjs/common";
import { AiAction } from "@prisma/client";
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

    const suggestion = this.client ? await this.askModel(message.text).catch(() => fallback) : fallback;

    return this.prisma.aiReplyLog.create({
      data: {
        messageId: message.id,
        conversationId: message.conversationId,
        detectedLanguage: suggestion.detected_language,
        intent: suggestion.intent,
        suggestedReply: suggestion.suggested_reply,
        confidence: suggestion.confidence,
        action: suggestion.action as AiAction,
        rawResponse: suggestion,
      },
    });
  }

  private async askModel(text: string) {
    const response = await this.client!.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an assistant for CoolFix Pro Supply CRM. Return only JSON with detected_language, intent, suggested_reply, confidence, action. Never auto-send. Complaints, refunds, insults, uncertain stock, and confidence under 0.7 must use action ask_human.",
        },
        { role: "user", content: text },
      ],
    });
    return JSON.parse(response.choices[0]?.message.content ?? "{}");
  }
}
