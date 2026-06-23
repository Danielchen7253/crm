"use client";

import {
  Bot,
  CheckCircle2,
  Clock3,
  Filter,
  Inbox,
  Mail,
  MessageCircle,
  Phone,
  Search,
  Send,
  Settings,
  Tag,
  UserRound,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { io } from "socket.io-client";

const API_BASE = "/api/backend";
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "https://coolfix-omni-api.onrender.com";

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
  attachments?: Attachment[];
  aiReplyLogs?: { id: string; suggestedReply?: string; confidence?: number; action?: string }[];
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
  const [activeChannel, setActiveChannel] = useState("all");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>("");
  const [detail, setDetail] = useState<Conversation | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
    socket.on("message.created", (event: { conversationId?: string }) => {
      loadConversations(activeChannel).catch(() => undefined);
      if (event.conversationId && event.conversationId === activeConversationId) {
        loadDetail(event.conversationId).catch(() => undefined);
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
    .flatMap((message) => message.aiReplyLogs ?? [])
    .find((item) => item.action !== "no_reply" && item.suggestedReply);

  const sendMessage = async () => {
    if (!selected || !draft.trim()) return;
    const text = draft.trim();
    setDraft("");
    await fetch(`${API_BASE}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: selected.id, text }),
    });
    await loadDetail(selected.id);
    await loadConversations(activeChannel);
  };

  return (
    <main className="shell">
      <aside className="rail">
        <div className="brand">CF</div>
        {channels.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={activeChannel === item.key ? "railButton active" : "railButton"}
              key={item.key}
              title={item.label}
              onClick={() => {
                setActiveChannel(item.key);
                setActiveConversationId("");
                setDetail(null);
              }}
            >
              <Icon size={20} />
            </button>
          );
        })}
        <button className="railButton bottom" title="系统设置">
          <Settings size={20} />
        </button>
      </aside>

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
                </article>
              ))}
            </div>
            <footer className="composer">
              <div className="aiDraft">
                <Bot size={16} />
                <span>{aiSuggestion?.suggestedReply ?? "AI 建议会在新消息进入后自动生成，只作为草稿，不自动发送。"}</span>
                {aiSuggestion?.suggestedReply && <button onClick={() => setDraft(aiSuggestion.suggestedReply ?? "")}>插入</button>}
              </div>
              <div className="inputRow">
                <textarea
                  placeholder="输入回复，WhatsApp 24 小时窗口外需要模板消息"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <button className="sendButton" title="发送" onClick={sendMessage}>
                  <Send size={20} />
                </button>
              </div>
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
    </main>
  );
}
