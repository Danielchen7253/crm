import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server, Socket } from "socket.io";

@WebSocketGateway({
  cors: {
    origin: process.env.WEB_ORIGIN?.split(",") ?? true,
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
