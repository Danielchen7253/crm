import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

const allowedSocketOrigins = (() => {
  const entries = [
    ...((process.env.WEB_ORIGIN ?? "").split(",") ?? []),
    ...((process.env.WEBSITE_CHAT_ALLOWED_ORIGINS ?? "").split(",") ?? []),
    process.env.API_PUBLIC_URL,
    process.env.PUBLIC_APP_URL,
  ];
  const normalized = entries
    .map((origin) => (origin ?? "").trim())
    .filter((origin) => origin.length > 0)
    .map((origin) => origin.replace(/\/+$/, ""));
  const deduped = Array.from(new Set(normalized));
  return deduped.length === 0 ? true : deduped;
})();

@WebSocketGateway({
  cors: {
    origin: process.env.CORS_ALLOW_ALL_ORIGINS === "1" ? true : allowedSocketOrigins,
    credentials: true,
  },
})
export class RealtimeGateway {
  @WebSocketServer()
  server!: Server;

  @SubscribeMessage("conversation.join")
  joinConversation(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    if (body?.conversationId) socket.join(`conversation:${body.conversationId}`);
    return { ok: true };
  }

  @SubscribeMessage("conversation.leave")
  leaveConversation(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    if (body?.conversationId) socket.leave(`conversation:${body.conversationId}`);
    return { ok: true };
  }

  @SubscribeMessage("typing.started")
  typingStarted(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    if (body?.conversationId) socket.to(`conversation:${body.conversationId}`).emit("typing.started", body);
    return { ok: true };
  }

  @SubscribeMessage("typing.stopped")
  typingStopped(@ConnectedSocket() socket: Socket, @MessageBody() body: { conversationId?: string }) {
    if (body?.conversationId) socket.to(`conversation:${body.conversationId}`).emit("typing.stopped", body);
    return { ok: true };
  }

  emitInboxEvent(event: string, payload: unknown) {
    this.server.emit(event, payload);
    const conversationId = typeof payload === "object" && payload && "conversationId" in payload ? String(payload.conversationId) : "";
    if (conversationId) this.server.to(`conversation:${conversationId}`).emit(event, payload);
  }
}
