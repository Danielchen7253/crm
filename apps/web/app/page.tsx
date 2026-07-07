"use client";

import {
  CheckCircle2,
  Clock3,
  FileText,
  Filter,
  ImageIcon,
  Inbox,
  Mail,
  MessageCircle,
  Mic,
  Paperclip,
  Phone,
  Search,
  Send,
  Settings,
  Sparkles,
  Tag,
  UserRound,
  Video,
  Volume2,
  X,
} from "lucide-react";
import { ClipboardEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  getNotificationSoundSettings,
  notificationToneOptions,
  playNewMessageSound,
  saveNotificationSoundSettings,
  shouldPlayNotificationSound,
  type NotificationSoundSettings,
  type NotificationSoundTone,
} from "./notificationSound";

const API_BASE = "/api/backend";
const SOCKET_URL =
  process.env.NEXT_PUBLIC_SOCKET_URL ??
  (process.env.NEXT_PUBLIC_API_URL?.replace(/\/api\/?$/, "").replace(/\/+$/, "") || "https://coolfix-omni-api.onrender.com");

const channels = [
  { key: "all", label: "鍏ㄩ儴", icon: Inbox },
  { key: "unread", label: "鏈", icon: Clock3 },
  { key: "messenger", label: "Messenger", icon: MessageCircle },
  { key: "whatsapp", label: "WhatsApp", icon: Phone },
  { key: "sms", label: "SMS", icon: Phone },
  { key: "instagram", label: "Instagram", icon: MessageCircle },
  { key: "email", label: "Email", icon: Mail },
  { key: "website_chat", label: "缃戠珯鑱婂ぉ", icon: MessageCircle },
  { key: "phone", label: "鐢佃瘽", icon: Phone },
];

type Attachment = {
  id: string;
  type: string;
  url: string;
  mimeType?: string;
  fileName?: string;
};

type Message = {
  id: string;
  direction: "inbound" | "outbound";
  channel?: string;
  type: string;
  text?: string;
  textContent?: string;
  text_content?: string;
  sentAt: string;
  status?: string;
  deliveredAt?: string | null;
  readAt?: string | null;
  failedReason?: string | null;
  providerErrorMessage?: string | null;
  updatedAt?: string;
  attachments?: Attachment[];
  aiReplyLogs?: { id: string; suggestedReply?: string; confidence?: number; action?: string }[];
};

type AiTrainingMaterial = {
  id: string;
  title: string;
  question: string;
  answer: string;
  language: string;
  intent: string;
  channel?: string | null;
  usageCount: number;
  isActive: boolean;
  updatedAt: string;
};

type AiGeneratedReply = {
  id: string;
  suggestedReply: string;
  confidence?: number;
  detectedLanguage?: string;
  intent?: string;
  alreadySaved?: boolean;
  messageId?: string | null;
};

type Identity = {
  id: string;
  channel: string;
  provider: string;
  externalId: string;
  phone?: string;
  email?: string;
  displayName?: string;
  avatarUrl?: string;
};

type Conversation = {
  id: string;
  channel: string;
  status: string;
  unreadCount: number;
  lastMessageAt?: string;
  customer: {
    id: string;
    displayName?: string;
    primaryPhone?: string;
    primaryEmail?: string;
    avatarUrl?: string;
    identities?: Identity[];
    tags?: { tag: { name: string; color?: string } }[];
  };
  messages?: Message[];
};

function formatTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  const now = Date.now();
  const diffMinutes = Math.max(0, Math.floor((now - date.getTime()) / 60000));
  if (diffMinutes < 1) return "鍒氬垰";
  if (diffMinutes < 60) return `${diffMinutes}鍒哷`;
  if (diffMinutes < 1440) return `${Math.floor(diffMinutes / 60)}灏忔椂`;
  return date.toLocaleDateString();
}

function channelLabel(channel: string) {
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "messenger") return "Messenger";
  if (channel === "website_chat") return "缃戠珯鑱婂ぉ";
  if (channel === "sms") return "SMS";
  if (channel === "phone") return "鐢佃瘽";
  return channel;
}

function lastMessageText(conversation: Conversation) {
  const message = conversation.messages?.[0];
  if (!message) return "鏆傛棤娑堟伅";
  return messageText(message) || (message.attachments?.length ? `[${message.attachments[0].type}]` : "鏂版秷鎭?");
}

function messageText(message: Message) {
  return message.textContent ?? message.text_content ?? message.text ?? "";
}

function conversationSortTime(conversation: Conversation) {
  const latestMessageTime = conversation.messages?.[0]?.sentAt;
  return new Date(conversation.lastMessageAt ?? latestMessageTime ?? 0).getTime();
}

function sortConversations(items: Conversation[]) {
  return [...items].sort((a, b) => conversationSortTime(b) - conversationSortTime(a));
}

function formatExactTime(value?: string | null) {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function isFailedMessage(message: Message) {
  return message.status === "failed" || Boolean(message.failedReason || message.providerErrorMessage);
}

function messageStatusText(message: Message) {
  const channel = channelLabel(message.channel ?? "");
  if (message.direction !== "outbound") {
    return `${channel} 鏀跺埌鏃堕棿 ${formatExactTime(message.sentAt)}`;
  }
  if (isFailedMessage(message)) {
    return `鍙戦€佸け璐ユ椂闂?${formatExactTime(message.updatedAt ?? message.sentAt)}`;
  }
  if (message.status === "queued") {
    return `姝ｅ湪閫氳繃 ${channel} 鍙戦€?`;
  }
  const successTime = message.deliveredAt ?? message.sentAt;
  return `鍙戦€佹垚鍔熸椂闂?${formatExactTime(successTime)}`;
}

function messageFailureReason(message: Message) {
  return message.failedReason ?? message.providerErrorMessage ?? "鍙戦€佸け璐?";
}

export default function Page() {
  const [workspace, setWorkspace] = useState<"inbox" | "aiTraining">("inbox");
  const [activeChannel, setActiveChannel] = useState("all");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>("");
  const [detail, setDetail] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [activeAiLogId, setActiveAiLogId] = useState<string | null>(null);
  const [aiGeneratedReply, setAiGeneratedReply] = useState<AiGeneratedReply | null>(null);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [replySaveStatus, setReplySaveStatus] = useState<Record<string, string>>({});
  const [trainingMaterials, setTrainingMaterials] = useState<AiTrainingMaterial[]>([]);
  const [trainingLoading, setTrainingLoading] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState<Record<string, string>>({});
  const [replayStatus, setReplayStatus] = useState("");
  const [attachmentOpen, setAttachmentOpen] = useState(false);
  const [soundSettings, setSoundSettings] = useState<NotificationSoundSettings>({
    enabled: true,
    volume: 0.7,
    tone: "chime",
  });
  const [sending, setSending] = useState(false);
  const [composerStatus, setComposerStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const readTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (window.matchMedia("(max-width: 759px)").matches) {
      window.location.replace("/mobile/inbox");
    }
    setSoundSettings(getNotificationSoundSettings());
  }, []);

  const loadConversations = useCallback(async (channel = activeChannel) => {
    const params = new URLSearchParams({ limit: "1000" });
    if (channel !== "all" && channel !== "unread") params.set("channel", channel);
    const response = await fetch(`${API_BASE}/conversations?${params.toString()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`conversations ${response.status}`);
    const data = (await response.json()) as Conversation[];
    const channelFiltered =
      channel !== "all" && channel !== "unread" ? data.filter((item) => item.channel === channel) : data;
    const visible = sortConversations(channel === "unread" ? channelFiltered.filter((item) => item.unreadCount > 0) : channelFiltered);
    setConversations(visible);
    if (!activeConversationId && visible[0]) setActiveConversationId(visible[0].id);
  }, [activeConversationId, activeChannel]);

  const loadDetail = useCallback(async (conversationId: string) => {
    const response = await fetch(`${API_BASE}/conversations/${conversationId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`conversation detail ${response.status}`);
    setDetail((await response.json()) as Conversation);
  }, []);

  useEffect(() => {
    setLoading(true);
    setError("");
    loadConversations(activeChannel)
      .catch((err) => setError(err instanceof Error ? err.message : "鍔犺浇澶辫触"))
      .finally(() => setLoading(false));
  }, [activeChannel, loadConversations]);

  useEffect(() => {
    if (!activeConversationId) return;
    loadDetail(activeConversationId).catch((err) => setError(err instanceof Error ? err.message : "鍔犺浇璇︽儏澶辫触"));
  }, [activeConversationId, loadDetail]);
  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socket.on("message.created", (event: { conversationId?: string; message?: { direction?: string | null } }) => {
      loadConversations(activeChannel).catch(() => undefined);
      if (event.conversationId && event.conversationId === activeConversationId) {
        loadDetail(event.conversationId).catch(() => undefined);
      }
      if (shouldPlayNotificationSound(event)) playNewMessageSound();
    });
    socket.on("message.status", (event: { conversationId?: string }) => {
      loadConversations(activeChannel).catch(() => undefined);
      if (event.conversationId && event.conversationId === activeConversationId) {
        loadDetail(event.conversationId).catch(() => undefined);
      }
    });
    socket.on("conversation.read", (event: { conversationId?: string }) => {
      loadConversations(activeChannel).catch(() => undefined);
      if (event.conversationId && event.conversationId === activeConversationId) {
        loadDetail(event.conversationId).catch(() => undefined);
      }
    });
    socket.on("conversation.updated", (event: { id?: string }) => {
      loadConversations(activeChannel).catch(() => undefined);
      if (event.id && event.id === activeConversationId) {
        loadDetail(event.id).catch(() => undefined);
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [activeChannel, activeConversationId, loadConversations, loadDetail]);
  const activeConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === activeConversationId) ?? conversations[0],
    [activeConversationId, conversations],
  );

  const selected = detail?.id === activeConversation?.id ? detail : activeConversation;
  const messages = selected?.messages ?? [];
  const aiSuggestion = messages
    .slice()
    .reverse()
    .flatMap((message) => message.aiReplyLogs ?? [])
    .find((item) => item.action !== "no_reply" && item.suggestedReply);
  const currentAiReply = aiGeneratedReply?.suggestedReply ? aiGeneratedReply : aiSuggestion ? {
    id: aiSuggestion.id,
    suggestedReply: aiSuggestion.suggestedReply ?? "",
    confidence: aiSuggestion.confidence,
  } : null;
  const aiScore = currentAiReply?.suggestedReply ? `${Math.round((currentAiReply.confidence ?? 0) * 100)}%` : "No score";

  function clearUnreadConversation(conversationId: string) {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === conversationId ? { ...conversation, unreadCount: 0 } : conversation,
      ),
    );
    setDetail((current) => (current?.id === conversationId ? { ...current, unreadCount: 0 } : current));
  }

  useEffect(() => {
    if (!aiSuggestion?.suggestedReply || !aiSuggestion.id || aiGeneratedReply) return;
    setDraft((current) => {
      if (current.trim()) return current;
      setActiveAiLogId(aiSuggestion.id ?? null);
      return aiSuggestion.suggestedReply ?? "";
    });
  }, [aiGeneratedReply, aiSuggestion?.id, aiSuggestion?.suggestedReply]);

  useEffect(() => {
    if (!selected || !selected.id || selected.unreadCount <= 0) return;
    clearUnreadConversation(selected.id);
    if (readTimeoutRef.current) clearTimeout(readTimeoutRef.current);

    readTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch(`${API_BASE}/conversations/${selected.id}/read`, {
          method: "POST",
        });
        if (!response.ok) {
          throw new Error(`Read failed ${response.status}`);
        }
        clearUnreadConversation(selected.id);
        await Promise.all([loadDetail(selected.id), loadConversations(activeChannel)]);
      } catch {
        // keep unread badge until next successful interaction
      }
    }, 1000);

    return () => {
      if (readTimeoutRef.current) {
        clearTimeout(readTimeoutRef.current);
        readTimeoutRef.current = null;
      }
    };
  }, [selected?.id, selected?.unreadCount, activeChannel, loadConversations, loadDetail]);

  useEffect(() => {
    resizeDraftBox();
  }, [draft]);

  const sendMessage = async () => {
    if (!selected || !draft.trim() || sending) return;
    const text = draft.trim();
    const aiLogId = activeAiLogId;
    setDraft("");
    setActiveAiLogId(null);
    setSending(true);
    setComposerStatus("");
    try {
      const response = await fetch(`${API_BASE}/messages/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversation_id: selected.id,
          conversationId: selected.id,
          channel: selected.channel,
          content_type: "text",
          text_content: text,
          attachment_ids: [],
          text,
          ai_reply_log_id: aiLogId,
          learning_sample: true,
        }),
      });
      if (!response.ok) throw new Error(`鍙戦€佸け璐?${response.status}`);
      const result = (await response.json().catch(() => ({}))) as { failedReason?: string };
      if (result.failedReason) setComposerStatus(result.failedReason);
      await loadDetail(selected.id);
      await loadConversations(activeChannel);
    } catch (err) {
      setDraft(text);
      setActiveAiLogId(aiLogId);
      setComposerStatus(err instanceof Error ? err.message : "鍙戦€佸け璐ワ紝璇烽噸璇?");
    } finally {
      setSending(false);
    }
  };

  function useAiSuggestion() {
    void generateAiReply();
  }

  async function generateAiReply() {
    if (!selected || aiGenerating) return;
    setAiGenerating(true);
    setComposerStatus("");
    try {
      const response = await fetch(`${API_BASE}/ai/conversations/${selected.id}/suggest-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error(`AI鐢熸垚澶辫触 ${response.status}`);
      const result = (await response.json()) as AiGeneratedReply;
      const suggestedReply = result.suggestedReply ?? "";
      setAiGeneratedReply(result);
      setDraft(suggestedReply);
      setActiveAiLogId(result.id ?? null);
    } catch (err) {
      setComposerStatus(err instanceof Error ? err.message : "AI鐢熸垚澶辫触");
    } finally {
      setAiGenerating(false);
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function setMessageSaveStatus(messageId: string, value: string) {
    setReplySaveStatus((current) => ({ ...current, [messageId]: value }));
  }

  async function saveMessageAsAiMaterial(message: Message) {
    const answer = messageText(message).trim();
    if (!selected || !answer) return;
    const messageTime = new Date(message.sentAt).getTime();
    const latestInbound = [...messages]
      .reverse()
      .find((item) => item.direction === "inbound" && messageText(item) && new Date(item.sentAt).getTime() <= messageTime);
    setMessageSaveStatus(message.id, "姝ｅ湪淇濆瓨AI鏁欐潗...");
    try {
      const response = await fetch(`${API_BASE}/ai/training-materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${channelLabel(selected.channel)} ${selected.customer.displayName ?? selected.customer.primaryPhone ?? "瀹㈡埛"} 鏁欐潗`,
          question: latestInbound ? messageText(latestInbound) : "General customer question",
          answer,
          language: aiGeneratedReply?.detectedLanguage ?? "unknown",
          intent: aiGeneratedReply?.intent ?? "other",
          channel: selected.channel,
          conversationId: selected.id,
          messageId: message.id,
          aiReplyLogId: message.aiReplyLogs?.[0]?.id ?? null,
          metadata: { savedFrom: "desktop_sent_message", customerMessageId: latestInbound?.id },
        }),
      });
      if (!response.ok) throw new Error(`淇濆瓨澶辫触 ${response.status}`);
      await response.json().catch(() => undefined);
      setMessageSaveStatus(message.id, "宸蹭繚瀛樹负AI鏁欐潗");
      await loadTrainingMaterials();
    } catch (err) {
      setMessageSaveStatus(message.id, err instanceof Error ? err.message : "淇濆瓨澶辫触");
    }
  }

  async function retryMessage(message: Message) {
    if (!selected || !isFailedMessage(message)) return;
    setComposerStatus("姝ｅ湪閲嶆柊鍙戦€?..");
    try {
      const response = await fetch(`${API_BASE}/messages/${message.id}/retry`, { method: "POST" });
      if (!response.ok) throw new Error(`閲嶆柊鍙戦€佸け璐?${response.status}`);
      const result = (await response.json().catch(() => ({}))) as { failedReason?: string; message?: Message };
      if (result.failedReason) {
        setComposerStatus(result.failedReason);
      } else {
        setComposerStatus("宸查噸鏂板彂閫?");
      }
      await loadDetail(selected.id);
      await loadConversations(activeChannel);
    } catch (err) {
      setComposerStatus(err instanceof Error ? err.message : "閲嶆柊鍙戦€佸け璐?");
    }
  }

  async function loadTrainingMaterials() {
    setTrainingLoading(true);
    try {
      const response = await fetch(`${API_BASE}/ai/training-materials`, { cache: "no-store" });
      if (!response.ok) throw new Error(`AI鏁欐潗鍔犺浇澶辫触 ${response.status}`);
      setTrainingMaterials((await response.json()) as AiTrainingMaterial[]);
    } finally {
      setTrainingLoading(false);
    }
  }

  async function replayHistoricalLearning() {
    setReplayStatus("姝ｅ湪鍥炴斁鍘嗗彶娑堟伅...");
    try {
      const response = await fetch(`${API_BASE}/ai/history/replay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 25 }),
      });
      if (!response.ok) throw new Error(`鍥炴斁澶辫触 ${response.status}`);
      const result = (await response.json()) as { processed?: number; saved?: number; skipped?: number; totalCandidates?: number };
      setReplayStatus(`宸插 ${result.processed ?? 0} 鏉℃秷鎭洖鏀堕€掑锛屾柊澧? ${result.saved ?? 0} 鏉℃暀鏉愶紝璺宠繃 ${result.skipped ?? 0} 鏉?`);
      await loadTrainingMaterials();
    } catch (err) {
      setReplayStatus(err instanceof Error ? err.message : "鍥炴斁澶辫触");
    }
  }

  function setMaterialDraft(id: string, patch: Partial<AiTrainingMaterial>) {
    setTrainingMaterials((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  function setMaterialStatus(id: string, value: string) {
    setTrainingStatus((current) => ({ ...current, [id]: value }));
  }

  async function updateTrainingMaterial(material: AiTrainingMaterial, patch?: Partial<AiTrainingMaterial>) {
    const next = { ...material, ...patch };
    setMaterialStatus(material.id, "姝ｅ湪淇濆瓨...");
    try {
      const response = await fetch(`${API_BASE}/ai/training-materials/${material.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: next.title,
          question: next.question,
          answer: next.answer,
          language: next.language,
          intent: next.intent,
          channel: next.channel ?? null,
        }),
      });
      if (!response.ok) throw new Error(`淇濆瓨澶辫触 ${response.status}`);
      const result = (await response.json()) as { material: AiTrainingMaterial };
      setTrainingMaterials((current) => current.map((item) => item.id === material.id ? result.material : item));
      setMaterialStatus(material.id, "宸蹭繚瀛?");
    } catch (err) {
      setMaterialStatus(material.id, err instanceof Error ? err.message : "淇濆瓨澶辫触");
    }
  }

  async function deleteTrainingMaterial(material: AiTrainingMaterial) {
      setMaterialStatus(material.id, "姝ｅ湪鍒犻櫎...");
    try {
      const response = await fetch(`${API_BASE}/ai/training-materials/${material.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`鍒犻櫎澶辫触 ${response.status}`);
      setTrainingMaterials((current) => current.filter((item) => item.id !== material.id));
    } catch (err) {
      setMaterialStatus(material.id, err instanceof Error ? err.message : "鍒犻櫎澶辫触");
    }
  }

  function resizeDraftBox() {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 26;
    const verticalPadding = Number.parseFloat(styles.paddingTop) + Number.parseFloat(styles.paddingBottom);
    const maxHeight = Math.ceil(lineHeight * 5 + verticalPadding);
    const minHeight = Math.ceil(lineHeight * 2 + verticalPadding);
    textarea.style.height = "auto";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const image = [...event.clipboardData.items].find((item) => item.type.startsWith("image/"));
    const file = image?.getAsFile();
    if (file) void uploadPickedFile(file);
  }

  async function uploadPickedFile(file?: File | null) {
    if (!file) return;
    const payload = new FormData();
    payload.append("file", file);
    setComposerStatus("姝ｅ湪涓婁紶闄勪欢...");
    const response = await fetch(`${API_BASE}/files/upload`, {
      method: "POST",
      body: payload,
    }).catch(() => null);
    if (!response?.ok) {
      setComposerStatus("闄勪欢鍔熻兘灏氭湭閰嶇疆鏂囦欢瀛樺偍锛涜鍏堢敤鏂囧瓧鍙戦€侊紝鏂囦欢瀛樺偍鎺ュ叆鍚庡啀鍚敤銆?");
      return;
    }
    setComposerStatus("闄勪欢宸蹭笂浼狅紝鍙互鍙戦€佺粰瀹㈡埛");
  }

  function updateSoundSettings(next: NotificationSoundSettings) {
    setSoundSettings(next);
    saveNotificationSoundSettings(next);
  }

  return (
    <main className="shell">
      <aside className="rail">
        <button className="brand brandButton" onClick={() => setWorkspace("inbox")} title="杩斿洖瀹㈡埛姹?">CF</button>
        {channels.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={activeChannel === item.key ? "railButton active" : "railButton"}
              key={item.key}
              title={item.label}
              onClick={() => {
                setWorkspace("inbox");
                setActiveChannel(item.key);
                setActiveConversationId("");
                setDetail(null);
              }}
            >
              <Icon size={20} />
            </button>
          );
        })}
        <button className={workspace === "aiTraining" ? "railButton bottom active" : "railButton bottom"} title="AI璁粌椤甸潰" onClick={() => {
          setWorkspace("aiTraining");
          void loadTrainingMaterials();
        }}>
          <Settings size={20} />
        </button>
      </aside>

      {workspace === "aiTraining" ? (
        <section className="aiTrainingPage">
          <header className="trainingHeader">
            <div>
              <h1>AI璁粌涓撶敤椤甸潰</h1>
              <p>鎶婁綘璁ゅ彲鐨勫洖澶嶄繚瀛樻垚鏁欐潗锛孉I 涓嬫浼氫紭鍏堝涔犲苟鍦ㄩ€傚悎鐨勫璇濅腑璋冪敤銆?</p>
            </div>
            <div className="trainingHeaderActions">
              <button onClick={() => void replayHistoricalLearning()}>鍥炴斁鍘嗗彶鍔犲</button>
              <button onClick={() => setWorkspace("inbox")}>杩斿洖瀹㈡埛姹?</button>
            </div>
          </header>
          {replayStatus && <div className="trainingReplayStatus">{replayStatus}</div>}
          <div className="trainingGrid">
            <section className="trainingPanel">
              <h2>宸蹭繚瀛楢I鏁欐潗</h2>
              <p className="trainingHint">{trainingLoading ? "姝ｅ湪鍔犺浇..." : `${trainingMaterials.length} 鏉℃暀鏉?`}</p>
              <div className="trainingMaterialList">
                {trainingMaterials.map((material) => (
                  <article className="trainingMaterialCard" key={material.id}>
                    <div className="trainingMaterialTop">
                      <input
                        value={material.title}
                        onChange={(event) => setMaterialDraft(material.id, { title: event.target.value })}
                        aria-label="鏁欐潗鏍囬"
                      />
                    </div>
                    <label>瀹㈡埛闂</label>
                    <textarea
                      value={material.question}
                      onChange={(event) => setMaterialDraft(material.id, { question: event.target.value })}
                      rows={3}
                    />
                    <label>鏍囧噯鍥炲</label>
                    <textarea
                      value={material.answer}
                      onChange={(event) => setMaterialDraft(material.id, { answer: event.target.value })}
                      rows={4}
                    />
                    <div className="trainingMetaEdit">
                      <input
                        value={material.language}
                        onChange={(event) => setMaterialDraft(material.id, { language: event.target.value })}
                        aria-label="璇█"
                      />
                      <input
                        value={material.intent}
                        onChange={(event) => setMaterialDraft(material.id, { intent: event.target.value })}
                        aria-label="鎰忓浘"
                      />
                      <select
                        value={material.channel ?? ""}
                        onChange={(event) => setMaterialDraft(material.id, { channel: event.target.value || null })}
                        aria-label="娓犻亾"
                      >
                        <option value="">鍏ㄩ儴娓犻亾</option>
                        <option value="messenger">Messenger</option>
                        <option value="whatsapp">WhatsApp</option>
                        <option value="sms">SMS</option>
                        <option value="instagram">Instagram</option>
                        <option value="email">Email</option>
                        <option value="website_chat">缃戠珯鑱婂ぉ</option>
                      </select>
                    </div>
                    <small>{material.channel ?? "鍏ㄩ儴娓犻亾"} 路 璋冪敤 {material.usageCount} 娆?</small>
                    <div className="trainingMaterialActions">
                      <button onClick={() => void updateTrainingMaterial(material)}>淇濆瓨淇敼</button>
                      <button className="danger" onClick={() => void deleteTrainingMaterial(material)}>鍒犻櫎</button>
                      {trainingStatus[material.id] && <span>{trainingStatus[material.id]}</span>}
                    </div>
                  </article>
                ))}
                {!trainingMaterials.length && !trainingLoading && <div className="emptyTraining">杩樻病鏈夋暀鏉愩€傚厛鍦ㄨ亰澶╂閲岃 AI 鐢熸垚绛斿锛屽啀鐐光€滀繚瀛樹负AI鏁欐潗鈥濄€?</div>}
              </div>
            </section>
            <section className="trainingPanel">
              <h2>鏂版秷鎭０闊宠缃?</h2>
                <p className="trainingHint">绯荤粺鏀跺埌瀹㈡埛鏂版秷鎭椂鎾斁锛屽彲鍦ㄨ繖閲岃皟澹伴煶銆?</p>
              <label className="soundToggle">
                <input
                  type="checkbox"
                  checked={soundSettings.enabled}
                  onChange={(event) => updateSoundSettings({ ...soundSettings, enabled: event.target.checked })}
                />
                寮€鍚０闊虫彁閱?
              </label>
              <label className="soundControl">
                <span>闊抽噺 {Math.round(soundSettings.volume * 100)}%</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(soundSettings.volume * 100)}
                  onChange={(event) => updateSoundSettings({ ...soundSettings, volume: Number(event.target.value) / 100 })}
                />
              </label>
              <label className="soundControl">
                <span>鎻愮ず闊?</span>
                <select
                  value={soundSettings.tone}
                  onChange={(event) => updateSoundSettings({ ...soundSettings, tone: event.target.value as NotificationSoundTone })}
                >
                  {notificationToneOptions.map((tone) => <option key={tone.value} value={tone.value}>{tone.label}</option>)}
                </select>
              </label>
              <button className="soundTestButton" onClick={() => playNewMessageSound({ force: true, settings: soundSettings })}>
                <Volume2 size={17} />
                娴嬭瘯澹伴煶
              </button>
            </section>
          </div>
        </section>
      ) : (
        <>

      <section className="listPane">
        <header className="paneHeader">
          <div>
            <h1>{activeChannel === "whatsapp" ? "WhatsApp 瀹㈡埛" : "瀹㈡埛姹?"}</h1>
            <p>{loading ? "姝ｅ湪鍚屾..." : `${conversations.length} 涓細璇?`}</p>
          </div>
          <button className="iconButton" title="绛涢€?">
            <Filter size={18} />
          </button>
        </header>
        <label className="search">
          <Search size={16} />
          <input placeholder="鎼滅储瀹㈡埛銆佺數璇濄€侀偖绠?" />
        </label>
        {error && <div className="statusLine">{error}</div>}
        <div className="conversationList">
          {conversations.map((conversation) => {
            const name =
              conversation.customer.displayName ??
              conversation.customer.primaryPhone ??
              conversation.customer.primaryEmail ??
              "鏂板鎴?";
            return (
              <button
                key={conversation.id}
                className={selected?.id === conversation.id ? "conversation active" : "conversation"}
                onClick={() => setActiveConversationId(conversation.id)}
              >
                {conversation.customer.avatarUrl ? (
                  <img className="avatarImage" src={conversation.customer.avatarUrl} alt="" />
                ) : (
                  <div className={`avatar ${conversation.channel}`}>{name.slice(0, 1).toUpperCase()}</div>
                )}
                <div className="conversationBody">
                  <div className="line">
                    <strong>{name}</strong>
                    <span>{formatTime(conversation.lastMessageAt)}</span>
                  </div>
                  <div className="line last">
                    <small>
                      {channelLabel(conversation.channel)} 路 {lastMessageText(conversation)}
                    </small>
                    {conversation.unreadCount > 0 && <b>{conversation.unreadCount}</b>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className="chatPane">
        {selected ? (
          <>
            <header className="chatHeader">
              {selected.customer.avatarUrl ? (
                <img className="avatarImage large" src={selected.customer.avatarUrl} alt="" />
              ) : (
                <div className={`avatar large ${selected.channel}`}>
                  {(selected.customer.displayName ?? selected.customer.primaryPhone ?? "C").slice(0, 1).toUpperCase()}
                </div>
              )}
              <div>
                <h2>{selected.customer.displayName ?? selected.customer.primaryPhone ?? "鏂板鎴?"}</h2>
                <p>
                  {channelLabel(selected.channel)} 路 鏈€杩戜簰鍔?{formatTime(selected.lastMessageAt)}
                </p>
              </div>
            </header>
            <div className="messages">
              {messages.map((message) => (
                <article key={message.id} className={`bubble ${message.direction} ${isFailedMessage(message) ? "failed" : ""}`}>
                  {messageText(message) && <p>{messageText(message)}</p>}
                  {message.attachments?.map((attachment) => (
                    <a key={attachment.id} className="attachment" href={attachment.url} target="_blank" rel="noreferrer">
                      {attachment.type === "image" ? "鏌ョ湅鍥剧墖" : attachment.type === "audio" ? "鎾斁璇煶" : attachment.fileName ?? "鎵撳紑闄勪欢"}
                    </a>
                  ))}
                  <div className="messageStatusLine">
                    <span>{messageStatusText(message)}</span>
                    {isFailedMessage(message) && (
                      <button onClick={() => void retryMessage(message)}>鐐瑰嚮鍐嶆鍙戦€?</button>
                    )}
                  </div>
                  {isFailedMessage(message) && <small className="messageFailureReason">{messageFailureReason(message)}</small>}
                  {message.direction === "outbound" && messageText(message).trim() && (
                    <div className="sentReplyActions">
                      <button onClick={() => void saveMessageAsAiMaterial(message)}>淇濆瓨涓篈I鏁欐潗</button>
                      {replySaveStatus[message.id] && <small>{replySaveStatus[message.id]}</small>}
                    </div>
                  )}
                </article>
              ))}
            </div>
            <footer className="composer">
              <div className="composerTools">
                <button className="composerToolBtn" onClick={() => setAttachmentOpen(true)} aria-label="娣诲姞闄勪欢">
                  <Paperclip size={18} />
                  娣诲姞闄勪欢
                </button>
                  <button className={currentAiReply?.suggestedReply ? "composerToolBtn active" : "composerToolBtn"} onClick={useAiSuggestion} aria-label="浣跨敤 AI 鐢熸垚鍥炲" disabled={aiGenerating}>
                    <Sparkles size={18} />
                    {aiGenerating ? "AI鐢熸垚涓?" : "AI"}
                    <span>{aiScore}</span>
                  </button>
                <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(event) => void uploadPickedFile(event.target.files?.[0])} />
                <input ref={fileInputRef} type="file" hidden onChange={(event) => void uploadPickedFile(event.target.files?.[0])} />
              </div>
              {composerStatus && <div className="composerStatus">{composerStatus}</div>}
              <div className="desktopComposer">
                  <textarea
                    ref={textareaRef}
                    placeholder="杈撳叆鍥炲锛學hatsApp 24 灏忔椂绐楀彛澶栭渶瑕佹ā鏉挎秷鎭?"
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    rows={1}
                  />
                <button className="sendButton" title="鍙戦€?" onClick={sendMessage} disabled={!draft.trim() || sending}>
                  <Send size={24} />
                </button>
              </div>
              {attachmentOpen && (
                <div className="desktopAttachmentMenu">
                  <div className="desktopAttachmentHeader">
                    <strong>娣诲姞闄勪欢</strong>
                    <button className="iconButton" onClick={() => setAttachmentOpen(false)} aria-label="鍏抽棴">
                      <X size={18} />
                    </button>
                  </div>
                  <button onClick={() => { imageInputRef.current?.click(); setAttachmentOpen(false); }}>
                    <ImageIcon size={18} />
                    鍥剧墖
                    <span>閫夋嫨浜у搧鍥俱€佺幇鍦哄浘</span>
                  </button>
                  <button onClick={() => { fileInputRef.current?.setAttribute("accept", "audio/*"); fileInputRef.current?.click(); setAttachmentOpen(false); }}>
                    <Mic size={18} />
                    闊抽
                    <span>璇煶鎴栧綍闊虫枃浠?</span>
                  </button>
                  <button onClick={() => { fileInputRef.current?.setAttribute("accept", "video/*"); fileInputRef.current?.click(); setAttachmentOpen(false); }}>
                    <Video size={18} />
                    瑙嗛
                    <span>瀹㈡埛鐜板満瑙嗛</span>
                  </button>
                  <button onClick={() => { fileInputRef.current?.removeAttribute("accept"); fileInputRef.current?.click(); setAttachmentOpen(false); }}>
                    <FileText size={18} />
                    鏂囦欢
                    <span>PDF銆乄ord銆丒xcel 绛?</span>
                  </button>
                </div>
              )}
            </footer>
          </>
        ) : (
          <div className="emptyState">鏆傛棤浼氳瘽銆俉hatsApp 瀹㈡埛鍙戞潵娑堟伅鍚庝細鑷姩杩涘叆杩欓噷銆?</div>
        )}
      </section>

      <aside className="detailPane">
        <header className="paneHeader">
          <div>
            <h2>瀹㈡埛璧勬枡</h2>
            <p>Customer overview</p>
          </div>
          <UserRound size={20} />
        </header>
        <section className="detailBlock">
          <label>瀹㈡埛鏍囩</label>
          <div className="tag">
            <Tag size={14} />
            {selected?.customer.tags?.map((item) => item.tag.name).join(", ") || "鏈垎绫诲鎴?"}
          </div>
        </section>
        <section className="detailBlock">
          <label>娓犻亾韬唤</label>
          {selected?.customer.identities?.map((identity) => (
            <div className="identity" key={identity.id}>
              <CheckCircle2 size={16} />
              {channelLabel(identity.channel)} {identity.phone || identity.email || identity.displayName || identity.externalId}
            </div>
          )) ?? <div className="identity">鏆傛棤韬唤</div>}
        </section>
        <section className="detailBlock">
          <label>鑱旂郴淇℃伅</label>
          <div className="identity"><Phone size={16} />{selected?.customer.primaryPhone || "鏃犳墜鏈哄彿"}</div>
          <div className="identity"><Mail size={16} />{selected?.customer.primaryEmail || "鏃犻偖绠?"}</div>
        </section>
      </aside>
      </>
      )}
    </main>
  );
}

