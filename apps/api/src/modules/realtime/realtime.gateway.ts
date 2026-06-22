import { WebSocketGateway, WebSocketServer } from "@nestjs/websockets";
import { Server } from "socket.io";

@WebSocketGateway({
  cors: {
    origin: process.env.WEB_ORIGIN?.split(",") ?? true,
    credentials: true,
  },
})
export class RealtimeGateway {
  @WebSocketServer()
  server!: Server;

  emitInboxEvent(event: string, payload: unknown) {
    this.server.emit(event, payload);
  }
}
