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
import { ClipboardEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
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
  { key: "all", label: "全部", icon: Inbox },
  { key: "unread", label: "未读", icon: Clock3 },
  { key: "messenger", label: "Messenger", icon: MessageCircle },
  { key: "whatsapp", label: "WhatsApp", icon: Phone },
  { key: "sms", label: "SMS", icon: Phone },
  { key: "instagram", label: "Instagram", icon: MessageCircle },
  { key: "email", label: "Email", icon: Mail },
  { key: "website_chat", label: "网站聊天", icon: MessageCircle },
  { key: "phone", label: "电话", icon: Phone },
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
  type: string;
  text?: string;
  sentAt: string;
  status?: string;
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
  if (diffMinutes < 1) return "刚刚";
  if (diffMinutes < 60) return `${diffMinutes}分`;
  if (diffMinutes < 1440) return `${Math.floor(diffMinutes / 60)}小时`;
  return date.toLocaleDateString();
}

function channelLabel(channel: string) {
  if (channel === "whatsapp") return "WhatsApp";
  if (channel === "messenger") return "Messenger";
  if (channel === "website_chat") return "网站聊天";
  if (channel === "sms") return "SMS";
  if (channel === "phone") return "电话";
  return channel;
}

function lastMessageText(conversation: Conversation) {
  const message = conversation.messages?.[0];
  if (!message) return "暂无消息";
  return message.text || (message.attachments?.length ? `[${message.attachments[0].type}]` : "新消息");
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

  useEffect(() => {
    if (window.matchMedia("(max-width: 759px)").matches) {
      window.location.replace("/mobile/inbox");
    }
    setSoundSettings(getNotificationSoundSettings());
  }, []);

  const loadConversations = async (channel = activeChannel) => {
    const params = channel !== "all" && channel !== "unread" ? `?channel=${channel}` : "";
    const response = await fetch(`${API_BASE}/conversations${params}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`conversations ${response.status}`);
    const data = (await response.json()) as Conversation[];
    const visible = channel === "unread" ? data.filter((item) => item.unreadCount > 0) : data;
    setConversations(visible);
    if (!activeConversationId && visible[0]) setActiveConversationId(visible[0].id);
  };

  const loadDetail = async (conversationId: string) => {
    const response = await fetch(`${API_BASE}/conversations/${conversationId}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`conversation detail ${response.status}`);
    setDetail((await response.json()) as Conversation);
  };

  useEffect(() => {
    setLoading(true);
    setError("");
    loadConversations(activeChannel)
      .catch((err) => setError(err instanceof Error ? err.message : "加载失败"))
      .finally(() => setLoading(false));
  }, [activeChannel]);

  useEffect(() => {
    if (!activeConversationId) return;
    loadDetail(activeConversationId).catch((err) => setError(err instanceof Error ? err.message : "加载详情失败"));
  }, [activeConversationId]);

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
    socket.on("conversation.updated", (event: { id?: string }) => {
      loadConversations(activeChannel).catch(() => undefined);
      if (event.id && event.id === activeConversationId) {
        loadDetail(event.id).catch(() => undefined);
      }
    });
    return () => {
      socket.disconnect();
    };
  }, [activeChannel, activeConversationId]);

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

  useEffect(() => {
    if (!aiSuggestion?.suggestedReply || !aiSuggestion.id || aiGeneratedReply) return;
    setDraft((current) => {
      if (current.trim()) return current;
      setActiveAiLogId(aiSuggestion.id ?? null);
      return aiSuggestion.suggestedReply ?? "";
    });
  }, [aiGeneratedReply, aiSuggestion?.id, aiSuggestion?.suggestedReply]);

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
      if (!response.ok) throw new Error(`发送失败 ${response.status}`);
      const result = (await response.json().catch(() => ({}))) as { failedReason?: string };
      if (result.failedReason) setComposerStatus(result.failedReason);
      await loadDetail(selected.id);
      await loadConversations(activeChannel);
    } catch (err) {
      setDraft(text);
      setActiveAiLogId(aiLogId);
      setComposerStatus(err instanceof Error ? err.message : "发送失败，请重试");
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
      if (!response.ok) throw new Error(`AI生成失败 ${response.status}`);
      const result = (await response.json()) as AiGeneratedReply;
      const suggestedReply = result.suggestedReply ?? "";
      setAiGeneratedReply(result);
      setDraft(suggestedReply);
      setActiveAiLogId(result.id ?? null);
    } catch (err) {
      setComposerStatus(err instanceof Error ? err.message : "AI生成失败");
    } finally {
      setAiGenerating(false);
    }
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function setMessageSaveStatus(messageId: string, value: string) {
    setReplySaveStatus((current) => ({ ...current, [messageId]: value }));
  }

  async function saveMessageAsAiMaterial(message: Message) {
    if (!selected || !message.text?.trim()) return;
    const messageTime = new Date(message.sentAt).getTime();
    const latestInbound = [...messages]
      .reverse()
      .find((item) => item.direction === "inbound" && item.text && new Date(item.sentAt).getTime() <= messageTime);
    setMessageSaveStatus(message.id, "正在保存AI教材...");
    try {
      const response = await fetch(`${API_BASE}/ai/training-materials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `${channelLabel(selected.channel)} ${selected.customer.displayName ?? selected.customer.primaryPhone ?? "客户"} 教材`,
          question: latestInbound?.text ?? "General customer question",
          answer: message.text.trim(),
          language: aiGeneratedReply?.detectedLanguage ?? "unknown",
          intent: aiGeneratedReply?.intent ?? "other",
          channel: selected.channel,
          conversationId: selected.id,
          messageId: message.id,
          aiReplyLogId: message.aiReplyLogs?.[0]?.id ?? null,
          metadata: { savedFrom: "desktop_sent_message", customerMessageId: latestInbound?.id },
        }),
      });
      if (!response.ok) throw new Error(`保存失败 ${response.status}`);
      await response.json().catch(() => undefined);
      setMessageSaveStatus(message.id, "已保存为AI教材");
      await loadTrainingMaterials();
    } catch (err) {
      setMessageSaveStatus(message.id, err instanceof Error ? err.message : "保存失败");
    }
  }

  async function saveMessageAsQuickReply(message: Message) {
    if (!selected || !message.text?.trim()) return;
    setMessageSaveStatus(message.id, "正在保存快捷回复...");
    try {
      const response = await fetch(`${API_BASE}/quick-replies`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: message.text.trim().slice(0, 40),
          channel: selected.channel,
          language: aiGeneratedReply?.detectedLanguage ?? "en",
          content: message.text.trim(),
          isActive: true,
        }),
      });
      if (!response.ok) throw new Error(`保存失败 ${response.status}`);
      setMessageSaveStatus(message.id, "已保存为快捷回复");
    } catch (err) {
      setMessageSaveStatus(message.id, err instanceof Error ? err.message : "保存失败");
    }
  }

  async function loadTrainingMaterials() {
    setTrainingLoading(true);
    try {
      const response = await fetch(`${API_BASE}/ai/training-materials`, { cache: "no-store" });
      if (!response.ok) throw new Error(`AI教材加载失败 ${response.status}`);
      setTrainingMaterials((await response.json()) as AiTrainingMaterial[]);
    } finally {
      setTrainingLoading(false);
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
    setComposerStatus("正在上传附件...");
    const response = await fetch(`${API_BASE}/files/upload`, {
      method: "POST",
      body: payload,
    }).catch(() => null);
    if (!response?.ok) {
      setComposerStatus("附件功能尚未配置文件存储；请先用文字发送，文件存储接入后再启用。");
      return;
    }
    setComposerStatus("附件已上传，可以发送给客户");
  }

  function updateSoundSettings(next: NotificationSoundSettings) {
    setSoundSettings(next);
    saveNotificationSoundSettings(next);
  }

  return (
    <main className="shell">
      <aside className="rail">
        <button className="brand brandButton" onClick={() => setWorkspace("inbox")} title="返回客户池">CF</button>
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
        <button className={workspace === "aiTraining" ? "railButton bottom active" : "railButton bottom"} title="AI训练页面" onClick={() => {
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
              <h1>AI训练专用页面</h1>
              <p>把你认可的回复保存成教材，AI 下次会优先学习并在适合的对话中调用。</p>
            </div>
            <button onClick={() => setWorkspace("inbox")}>返回客户池</button>
          </header>
          <div className="trainingGrid">
            <section className="trainingPanel">
              <h2>已保存AI教材</h2>
              <p className="trainingHint">{trainingLoading ? "正在加载..." : `${trainingMaterials.length} 条教材`}</p>
              <div className="trainingMaterialList">
                {trainingMaterials.map((material) => (
                  <article className="trainingMaterialCard" key={material.id}>
                    <div className="trainingMaterialTop">
                      <strong>{material.title}</strong>
                      <span>{material.language} · {material.intent}</span>
                    </div>
                    <label>客户问题</label>
                    <p>{material.question}</p>
                    <label>标准回复</label>
                    <p>{material.answer}</p>
                    <small>{material.channel ?? "全部渠道"} · 调用 {material.usageCount} 次</small>
                  </article>
                ))}
                {!trainingMaterials.length && !trainingLoading && <div className="emptyTraining">还没有教材。先在聊天框里让 AI 生成答复，再点“保存为AI教材”。</div>}
              </div>
            </section>
            <section className="trainingPanel">
              <h2>新消息声音设置</h2>
              <p className="trainingHint">系统收到客户新消息时播放，可在这里调声音。</p>
              <label className="soundToggle">
                <input
                  type="checkbox"
                  checked={soundSettings.enabled}
                  onChange={(event) => updateSoundSettings({ ...soundSettings, enabled: event.target.checked })}
                />
                开启声音提醒
              </label>
              <label className="soundControl">
                <span>音量 {Math.round(soundSettings.volume * 100)}%</span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={Math.round(soundSettings.volume * 100)}
                  onChange={(event) => updateSoundSettings({ ...soundSettings, volume: Number(event.target.value) / 100 })}
                />
              </label>
              <label className="soundControl">
                <span>提示音</span>
                <select
                  value={soundSettings.tone}
                  onChange={(event) => updateSoundSettings({ ...soundSettings, tone: event.target.value as NotificationSoundTone })}
                >
                  {notificationToneOptions.map((tone) => <option key={tone.value} value={tone.value}>{tone.label}</option>)}
                </select>
              </label>
              <button className="soundTestButton" onClick={() => playNewMessageSound({ force: true, settings: soundSettings })}>
                <Volume2 size={17} />
                测试声音
              </button>
            </section>
          </div>
        </section>
      ) : (
        <>

      <section className="listPane">
        <header className="paneHeader">
          <div>
            <h1>{activeChannel === "whatsapp" ? "WhatsApp 客户" : "客户池"}</h1>
            <p>{loading ? "正在同步..." : `${conversations.length} 个会话`}</p>
          </div>
          <button className="iconButton" title="筛选">
            <Filter size={18} />
          </button>
        </header>
        <label className="search">
          <Search size={16} />
          <input placeholder="搜索客户、电话、邮箱" />
        </label>
        {error && <div className="statusLine">{error}</div>}
        <div className="conversationList">
          {conversations.map((conversation) => {
            const name =
              conversation.customer.displayName ??
              conversation.customer.primaryPhone ??
              conversation.customer.primaryEmail ??
              "新客户";
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
                      {channelLabel(conversation.channel)} · {lastMessageText(conversation)}
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
                <h2>{selected.customer.displayName ?? selected.customer.primaryPhone ?? "新客户"}</h2>
                <p>
                  {channelLabel(selected.channel)} · 最近互动 {formatTime(selected.lastMessageAt)}
                </p>
              </div>
            </header>
            <div className="messages">
              {messages.map((message) => (
                <article key={message.id} className={`bubble ${message.direction}`}>
                  {message.text && <p>{message.text}</p>}
                  {message.attachments?.map((attachment) => (
                    <a key={attachment.id} className="attachment" href={attachment.url} target="_blank" rel="noreferrer">
                      {attachment.type === "image" ? "查看图片" : attachment.type === "audio" ? "播放语音" : attachment.fileName ?? "打开附件"}
                    </a>
                  ))}
                  <span>{new Date(message.sentAt).toLocaleString()}</span>
                  {message.direction === "outbound" && message.text && message.status !== "failed" && (
                    <div className="sentReplyActions">
                      <button onClick={() => void saveMessageAsQuickReply(message)}>保存快捷回复</button>
                      <button onClick={() => void saveMessageAsAiMaterial(message)}>保存AI教材</button>
                      {replySaveStatus[message.id] && <small>{replySaveStatus[message.id]}</small>}
                    </div>
                  )}
                </article>
              ))}
            </div>
            <footer className="composer">
              <div className="composerTools">
                <button className="composerToolBtn" onClick={() => setAttachmentOpen(true)} aria-label="添加附件">
                  <Paperclip size={18} />
                  添加附件
                </button>
                <button className={currentAiReply?.suggestedReply ? "composerToolBtn active" : "composerToolBtn"} onClick={useAiSuggestion} aria-label="使用 AI 生成回复" disabled={aiGenerating}>
                  <Sparkles size={18} />
                  {aiGenerating ? "AI生成中" : "AI"}
                  <span>{aiScore}</span>
                </button>
                <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(event) => void uploadPickedFile(event.target.files?.[0])} />
                <input ref={fileInputRef} type="file" hidden onChange={(event) => void uploadPickedFile(event.target.files?.[0])} />
              </div>
              {composerStatus && <div className="composerStatus">{composerStatus}</div>}
              <div className="desktopComposer">
                <textarea
                  ref={textareaRef}
                  placeholder="输入回复，WhatsApp 24 小时窗口外需要模板消息"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                  onPaste={onPaste}
                  rows={1}
                />
                <button className="sendButton" title="发送" onClick={sendMessage} disabled={!draft.trim() || sending}>
                  <Send size={24} />
                </button>
              </div>
              {attachmentOpen && (
                <div className="desktopAttachmentMenu">
                  <div className="desktopAttachmentHeader">
                    <strong>添加附件</strong>
                    <button className="iconButton" onClick={() => setAttachmentOpen(false)} aria-label="关闭">
                      <X size={18} />
                    </button>
                  </div>
                  <button onClick={() => { imageInputRef.current?.click(); setAttachmentOpen(false); }}>
                    <ImageIcon size={18} />
                    图片
                    <span>选择产品图、现场图</span>
                  </button>
                  <button onClick={() => { fileInputRef.current?.setAttribute("accept", "audio/*"); fileInputRef.current?.click(); setAttachmentOpen(false); }}>
                    <Mic size={18} />
                    音频
                    <span>语音或录音文件</span>
                  </button>
                  <button onClick={() => { fileInputRef.current?.setAttribute("accept", "video/*"); fileInputRef.current?.click(); setAttachmentOpen(false); }}>
                    <Video size={18} />
                    视频
                    <span>客户现场视频</span>
                  </button>
                  <button onClick={() => { fileInputRef.current?.removeAttribute("accept"); fileInputRef.current?.click(); setAttachmentOpen(false); }}>
                    <FileText size={18} />
                    文件
                    <span>PDF、Word、Excel 等</span>
                  </button>
                </div>
              )}
            </footer>
          </>
        ) : (
          <div className="emptyState">暂无会话。WhatsApp 客户发来消息后会自动进入这里。</div>
        )}
      </section>

      <aside className="detailPane">
        <header className="paneHeader">
          <div>
            <h2>客户资料</h2>
            <p>一个客户主档</p>
          </div>
          <UserRound size={20} />
        </header>
        <section className="detailBlock">
          <label>客户标签</label>
          <div className="tag">
            <Tag size={14} />
            {selected?.customer.tags?.map((item) => item.tag.name).join(", ") || "未分类客户"}
          </div>
        </section>
        <section className="detailBlock">
          <label>渠道身份</label>
          {selected?.customer.identities?.map((identity) => (
            <div className="identity" key={identity.id}>
              <CheckCircle2 size={16} />
              {channelLabel(identity.channel)} {identity.phone || identity.email || identity.displayName || identity.externalId}
            </div>
          )) ?? <div className="identity">暂无身份</div>}
        </section>
        <section className="detailBlock">
          <label>联系信息</label>
          <div className="identity"><Phone size={16} />{selected?.customer.primaryPhone || "无手机号"}</div>
          <div className="identity"><Mail size={16} />{selected?.customer.primaryEmail || "无邮箱"}</div>
        </section>
      </aside>
      </>
      )}
    </main>
  );
}
