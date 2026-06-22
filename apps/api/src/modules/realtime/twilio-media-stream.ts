import { IncomingMessage } from "node:http";
import { parse } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { CallsService } from "../calls/calls.service";

type TwilioMessage =
  | { event: "connected"; protocol: string; version: string }
  | { event: "start"; start: { streamSid: string; callSid: string } }
  | { event: "media"; media: { payload: string; track?: string } }
  | { event: "stop"; stop: { callSid: string } };

export function attachTwilioMediaStream(server: any, calls: CallsService) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket: any, head: Buffer) => {
    const { pathname } = parse(request.url ?? "");
    if (pathname !== "/api/realtime/connect") return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (twilio, request) => {
    void handleCallStream(twilio, request, calls);
  });
}

async function handleCallStream(twilio: WebSocket, request: IncomingMessage, calls: CallsService) {
  const query = new URL(request.url ?? "", "https://local").searchParams;
  const callSessionId = query.get("callSessionId");
  let streamSid = "";
  let openai: WebSocket | null = null;

  if (!callSessionId) {
    twilio.close(1008, "missing callSessionId");
    return;
  }

  await calls.markRealtimeConnected(callSessionId, { connectedAt: new Date().toISOString() });

  if (process.env.OPENAI_API_KEY) {
    openai = connectOpenAiRealtime({
      onAudioDelta: (payload) => {
        if (!streamSid || twilio.readyState !== WebSocket.OPEN) return;
        twilio.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
      },
      onTranscript: (speaker, text, isFinal) => {
        if (!text) return;
        void calls.addTranscript({ callSessionId, speaker, text, isFinal, rawEvent: { source: "openai-realtime" } });
      },
      onHandoff: (reason, confidence) => {
        void calls.requireHandoff(callSessionId, reason, confidence);
      },
    });
  }

  twilio.on("message", (raw) => {
    const data = JSON.parse(raw.toString()) as TwilioMessage;
    if (data.event === "start") {
      streamSid = data.start.streamSid;
      return;
    }
    if (data.event === "media" && openai?.readyState === WebSocket.OPEN) {
      openai.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
      return;
    }
    if (data.event === "stop") {
      void calls.endCall(callSessionId, { endedBy: "twilio-stop" });
      openai?.close();
    }
  });

  twilio.on("close", () => {
    openai?.close();
  });
}

function connectOpenAiRealtime(handlers: {
  onAudioDelta: (payload: string) => void;
  onTranscript: (speaker: string, text: string, isFinal: boolean) => void;
  onHandoff: (reason: string, confidence?: number) => void;
}) {
  const model = process.env.OPENAI_REALTIME_MODEL ?? "gpt-4o-realtime-preview";
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${model}`, {
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  ws.on("open", () => {
    ws.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          voice: process.env.OPENAI_REALTIME_VOICE ?? "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 650 },
          instructions: [
            "You are Coolfix Pro customer service.",
            "Support English and Spanish. Reply in the customer's language.",
            "Coolfix Pro supplies HVAC and refrigeration parts across the United States.",
            "Collect name, phone, email, company, product model, quantity, and need.",
            "Do not invent stock, price, delivery time, or technical specifications.",
            "If the customer asks for quote, stock confirmation, complaint, refund, technical support, or you are unsure, say a team member will contact them shortly and mark handoff.",
          ].join(" "),
        },
      }),
    );
  });

  ws.on("message", (raw) => {
    const event = JSON.parse(raw.toString());
    if (event.type === "response.audio.delta" && event.delta) {
      handlers.onAudioDelta(event.delta);
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      handlers.onTranscript("customer", event.transcript ?? "", true);
    }
    if (event.type === "response.audio_transcript.done") {
      handlers.onTranscript("ai", event.transcript ?? "", true);
    }
    if (event.type === "response.done") {
      const text = JSON.stringify(event.response ?? {});
      if (/quote|stock|refund|complaint|technical/i.test(text)) {
        handlers.onHandoff("policy-required-human-review", 0.7);
      }
    }
  });

  return ws;
}
