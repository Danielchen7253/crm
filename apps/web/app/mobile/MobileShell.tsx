"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Bell,
  Bot,
  CheckCircle2,
  ChevronLeft,
  Circle,
  FileText,
  ImageIcon,
  Mail,
  Menu,
  Mic,
  Paperclip,
  Search,
  Send,
  UserRound,
  Users,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./mobile.css";

const API_BASE = "/api/backend";
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "https://coolfix-omni-api.onrender.com";
const DEFAULT_TOKEN = "development-token";
const TOKEN_KEY = "coolfix.crm.mobile.web.token";
const DRAFT_PREFIX = "coolfix.crm.mobile.draft.";
const TASK_KEY = "coolfix.crm.mobile.web.tasks";

type Channel = "messenger" | "whatsapp" | "sms" | "instagram" | "email" | "website_chat" | "phone";
type Filter = "all" | "unread" | "mine" | Channel;
type Mode = "inbox" | "conversation" | "customers" | "customer" | "tasks" | "me";

type Attachment = {
  id: string;
  type: "image" | "audio" | "video" | "file";
  url: string;
  fileName?: string | null;
};

type Message = {
  id: string;
  direction: "inbound" | "outbound" | "internal";
  type: string;
  status: string;
  text?: string | null;
  sentAt: string;
  failedReason?: string | null;
  attachments?: Attachment[];
  aiReplyLogs?: { suggestedReply?: string | null; confidence?: number | null; action?: string | null; detectedLanguage?: string | null }[];
};

type Customer = {
  id: string;
  displayName?: string | null;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  avatarUrl?: string | null;
  source?: Channel | null;
  lastMessageAt?: string | null;
  identities?: { id: string; channel: Channel; externalId: string; phone?: string | null; email?: string | null; displayName?: string | null }[];
  tags?: { tag: { name: string; color?: string | null } }[];
  notes?: { id: string; body: string; createdAt: string }[];
  conversations?: { id: string; channel: Channel; lastMessageAt?: string | null }[];
};

type Conversation = {
  id: string;
  channel: Channel;
  status: string;
  unreadCount: number;
  lastMessageAt?: string | null;
  customer: Customer;
  messages?: Message[];
  assignedTo?: { id: string; name: string; email: string } | null;
};

type QuickReply = {
  id: string;
  name: string;
  channel?: Channel | null;
  language: string;
  content: string;
  isActive: boolean;
};

type FollowTask = {
  id: string;
  title: string;
  customerId?: string;
  customerName?: string;
  dueAt: string;
  done: boolean;
};

const channelNames: Record<Channel, string> = {
  messenger: "Messenger",
  whatsapp: "WhatsApp",
  sms: "SMS",
  instagram: "Instagram",
  email: "Email",
  website_chat: "Website Chat",
  phone: "Phone",
};

const filters: Filter[] = ["all", "unread", "mine", "messenger", "whatsapp", "sms", "instagram", "email", "website_chat"];
const defaultQuickNames = [
  "Business Hours",
  "Pickup Address",
  "Shipping Available",
  "Wholesale Price",
  "Warranty Policy",
  "Ask Model Number",
  "Ask Quantity",
  "Spanish Greeting",
];
const defaultTags = ["VIP", "Wholesale", "HVAC", "Refrigeration", "Follow Up", "Customer", "Supplier"];

export default function MobileShell({ mode }: { mode: Mode }) {
  const router = useRouter();
  const params = useParams<{ id?: string }>();
  const [token, setToken] = useState(DEFAULT_TOKEN);
  const [loginValue, setLoginValue] = useState("");
  const [loginMode, setLoginMode] = useState<"email" | "phone">("email");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [draft, setDraft] = useState("");
  const [tasks, setTasks] = useState<FollowTask[]>([]);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDueAt, setTaskDueAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const conversationId = mode === "conversation" ? params.id : undefined;
  const customerId = mode === "customer" ? params.id : undefined;

  const metrics = useMemo(() => {
    const today = new Date().toDateString();
    return {
      unread: conversations.reduce((sum, item) => sum + item.unreadCount, 0),
      waiting: conversations.filter((item) => item.messages?.[0]?.direction === "inbound").length,
      todayNew: customers.filter((item) => item.lastMessageAt && new Date(item.lastMessageAt).toDateString() === today).length,
    };
  }, [conversations, customers]);

  const aiSuggestion = useMemo(() => {
    const logs = [...(conversation?.messages ?? [])].reverse().flatMap((message) => message.aiReplyLogs ?? []);
    return logs.find((log) => log.action !== "no_reply" && log.suggestedReply);
  }, [conversation]);

  const loadConversations = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter !== "all" && filter !== "unread" && filter !== "mine") params.set("channel", filter);
    if (query.trim()) params.set("q", query.trim());
    const data = await api<Conversation[]>(`/conversations${params.size ? `?${params}` : ""}`, token);
    const visible = filter === "unread" ? data.filter((item) => item.unreadCount > 0) : data;
    setConversations(visible);
  }, [filter, query, token]);

  const loadCustomers = useCallback(async () => {
    const params = query.trim() ? `?q=${encodeURIComponent(query.trim())}` : "";
    setCustomers(await api<Customer[]>(`/customers${params}`, token));
  }, [query, token]);

  const loadConversation = useCallback(async (id: string) => {
    const data = await api<Conversation>(`/conversations/${id}`, token);
    setConversation(data);
    setDraft(localStorage.getItem(`${DRAFT_PREFIX}${id}`) ?? "");
  }, [token]);

  const loadCustomer = useCallback(async (id: string) => {
    setCustomer(await api<Customer>(`/customers/${id}`, token));
  }, [token]);

  const loadQuickReplies = useCallback(async () => {
    const data = await api<QuickReply[]>("/quick-replies", token);
    setQuickReplies(data.length ? data : defaultQuickNames.map((name, index) => ({
      id: `default-${index}`,
      name,
      channel: null,
      language: "en",
      content: name,
      isActive: true,
    })));
  }, [token]);

  const loadAll = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      await Promise.all([loadConversations(), loadCustomers(), loadQuickReplies()]);
      if (conversationId) await loadConversation(conversationId);
      if (customerId) await loadCustomer(customerId);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      setLoading(false);
    }
  }, [conversationId, customerId, loadConversation, loadConversations, loadCustomer, loadCustomers, loadQuickReplies, token]);

  useEffect(() => {
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      setToken(saved);
    } else {
      localStorage.setItem(TOKEN_KEY, DEFAULT_TOKEN);
    }
    const rawTasks = localStorage.getItem(TASK_KEY);
    if (rawTasks) setTasks(JSON.parse(rawTasks) as FollowTask[]);
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (!token) return;
    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socket.on("connect", () => setOffline(false));
    socket.on("disconnect", () => setOffline(true));
    socket.on("message.created", (event: { conversationId?: string }) => {
      void loadConversations();
      if (event.conversationId && event.conversationId === conversationId) void loadConversation(event.conversationId);
      void notify("New customer message", "Open CRM Mobile Web to reply.");
      playBeep();
    });
    socket.on("message.status", (event: { conversationId?: string }) => {
      void loadConversations();
      if (event.conversationId && event.conversationId === conversationId) void loadConversation(event.conversationId);
    });
    socket.on("conversation.updated", (event: { id?: string }) => {
      void loadConversations();
      if (event.id && event.id === conversationId) void loadConversation(event.id);
    });
    return () => {
      socket.disconnect();
    };
  }, [conversationId, loadConversation, loadConversations, token]);

  useEffect(() => {
    if (conversationId) localStorage.setItem(`${DRAFT_PREFIX}${conversationId}`, draft);
  }, [conversationId, draft]);

  useEffect(() => {
    if (mode !== "conversation") return;
    messagesEndRef.current?.scrollIntoView({ block: "end" });
  }, [mode, conversation?.id, conversation?.messages?.length]);

  async function login(provider?: "google" | "facebook") {
    const value = provider ? `${provider}@coolfixpro.com` : loginValue.trim();
    if (!value) return;
    const email = loginMode === "phone" && !provider ? `${value.replace(/\D/g, "")}@phone.coolfixpro.com` : value;
    const result = await api<{ accessToken: string }>("/auth/login", "", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    localStorage.setItem(TOKEN_KEY, result.accessToken);
    setToken(result.accessToken);
    router.replace("/mobile/inbox");
  }

  async function sendMessage(text = draft) {
    if (!conversation || !text.trim()) return;
    const pendingText = text.trim();
    setDraft("");
    try {
      const result = await api<{ failedReason?: string }>("/messages/send", token, {
        method: "POST",
        body: JSON.stringify({ conversationId: conversation.id, text: pendingText }),
      });
      if (result.failedReason) {
        setDraft(pendingText);
        alert(`Send failed: ${result.failedReason}`);
      }
      await loadConversation(conversation.id);
    } catch {
      setDraft(pendingText);
      setOffline(true);
    }
  }

  async function retryMessage(messageId: string) {
    await api(`/messages/${messageId}/retry`, token, { method: "POST" });
    if (conversationId) await loadConversation(conversationId);
    await loadConversations();
  }

  function saveTask() {
    if (!taskTitle.trim()) return;
    const next = [{
      id: `${Date.now()}`,
      title: taskTitle.trim(),
      customerId: conversation?.customer.id ?? customer?.id,
      customerName: conversation?.customer.displayName ?? customer?.displayName ?? undefined,
      dueAt: taskDueAt.trim() || "Tomorrow 3:00 PM",
      done: false,
    }, ...tasks];
    setTasks(next);
    localStorage.setItem(TASK_KEY, JSON.stringify(next));
    setTaskTitle("");
    setTaskDueAt("");
  }

  function toggleTask(id: string) {
    const next = tasks.map((item) => item.id === id ? { ...item, done: !item.done } : item);
    setTasks(next);
    localStorage.setItem(TASK_KEY, JSON.stringify(next));
  }

  if (!token) {
    return (
      <main className="mobileApp">
        <section className="mobilePanel" style={{ marginTop: 96 }}>
          <h1 className="mobileTitle">CRM Mobile Web</h1>
          <p className="mobileMeta">Open web, reply customers, close web.</p>
          <div className="mobileActions" style={{ margin: "14px 0 8px" }}>
            <button className={loginMode === "email" ? "mobileActionBtn" : "mobileQuickBtn"} onClick={() => setLoginMode("email")}>Email</button>
            <button className={loginMode === "phone" ? "mobileActionBtn" : "mobileQuickBtn"} onClick={() => setLoginMode("phone")}>Phone</button>
          </div>
          <input className="mobileInput" value={loginValue} onChange={(event) => setLoginValue(event.target.value)} placeholder={loginMode === "phone" ? "Phone number" : "Email address"} />
          <button className="mobilePrimary" onClick={() => void login()}>Log in</button>
          <div className="mobileActions" style={{ marginTop: 10 }}>
            <button className="mobileActionBtn" onClick={() => void login("google")}>Google</button>
            <button className="mobileActionBtn" onClick={() => void login("facebook")}>Facebook</button>
          </div>
        </section>
      </main>
    );
  }

  if (mode === "conversation" && !conversation) {
    return (
      <main className="mobileChat">
        <header className="mobileChatHeader">
          <Link className="mobileBackBtn" href="/mobile/inbox"><ChevronLeft size={22} /></Link>
          <div className="mobileAvatar phone">C</div>
          <div className="mobileChatInfo">
            <div className="mobileCustomerName">Loading conversation</div>
            <div className="mobileMeta">Syncing messages...</div>
          </div>
        </header>
        <section className="mobileMessages">
          <div className="mobileEmptyChat">Loading customer chat...</div>
        </section>
        <section className="mobileComposerWrap">
          <div className="mobileComposer">
            <button className="mobileFileBtn" title="Upload file"><Paperclip size={20} /></button>
            <textarea disabled placeholder="Loading..." />
            <button className="mobileSendBtn" disabled><Send size={19} /></button>
          </div>
        </section>
      </main>
    );
  }

  if (mode === "conversation" && conversation) {
    const orderedMessages = [...(conversation.messages ?? [])].sort(
      (left, right) => new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime(),
    );

    return (
      <main className="mobileChat">
        <header className="mobileChatHeader">
          <Link className="mobileBackBtn" href="/mobile/inbox"><ChevronLeft size={22} /></Link>
          <Avatar customer={conversation.customer} channel={conversation.channel} />
          <div className="mobileChatInfo">
            <div className="mobileCustomerName">{conversation.customer.displayName ?? conversation.customer.primaryPhone ?? "New customer"}</div>
            <div className="mobileMeta">{channelNames[conversation.channel]} · {formatTime(conversation.lastMessageAt)}</div>
          </div>
          <Link className="mobileIconBtn" href={`/mobile/customers/${conversation.customer.id}`}><UserRound size={19} /></Link>
        </header>
        <section className="mobileMessages">
          {orderedMessages.map((message) => (
            <article key={message.id} className={`mobileBubble ${message.direction}`}>
              {message.text && <p>{message.text}</p>}
              {message.attachments?.map((attachment) => <AttachmentPreview attachment={attachment} key={attachment.id} />)}
              <small>{formatTime(message.sentAt)} · {message.status}{message.failedReason ? ` · ${message.failedReason}` : ""}</small>
            </article>
          ))}
          <div ref={messagesEndRef} />
        </section>
        <section className="mobileComposerWrap">
          {aiSuggestion?.suggestedReply && (
            <div className="mobileAi">
              <div className="mobileAiTitle">AI suggestion · {Math.round((aiSuggestion.confidence ?? 0) * 100)}%</div>
              <p>{aiSuggestion.suggestedReply}</p>
              <div className="mobileActions">
                <button className="mobileActionBtn" onClick={() => void sendMessage(aiSuggestion.suggestedReply ?? "")}>Send</button>
                <button className="mobileActionBtn" onClick={() => setDraft(aiSuggestion.suggestedReply ?? "")}>Edit then send</button>
                <button className="mobileQuickBtn">Ignore</button>
              </div>
            </div>
          )}
          <div className="mobileQuickReplies">
            {quickReplies.filter((reply) => reply.isActive && (!reply.channel || reply.channel === conversation.channel)).slice(0, 12).map((reply) => (
              <button className="mobileQuickBtn" key={reply.id} onClick={() => setDraft(reply.content)}>{reply.name}</button>
            ))}
          </div>
          <div className="mobileComposer">
            <button className="mobileFileBtn" title="Upload file"><Paperclip size={20} /></button>
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Type reply" />
            <button className="mobileSendBtn" onClick={() => void sendMessage()}><Send size={19} /></button>
          </div>
        </section>
        {offline && <div className="mobileOffline">Network disconnected. Reconnecting...</div>}
      </main>
    );
  }

  return (
    <main className="mobileApp">
      <MobileTop title={titleFor(mode)} metrics={metrics} loading={loading} onRefresh={() => void loadAll()} />
      {(mode === "inbox" || mode === "customers") && (
        <label className="mobileSearch">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && void loadAll()} placeholder="Search name, phone, email, tag, message" />
        </label>
      )}
      {mode === "inbox" && (
        <>
          <div className="mobileFilters">
            {filters.map((item) => <button className={filter === item ? "mobileFilter active" : "mobileFilter"} key={item} onClick={() => setFilter(item)}>{filterLabel(item)}</button>)}
          </div>
          <section className="mobileList">
            {conversations.map((item) => <ConversationCard conversation={item} key={item.id} />)}
          </section>
        </>
      )}
      {mode === "customers" && (
        <section className="mobileList">
          <div className="mobileFilters">
            {defaultTags.map((tag) => <span className="mobileFilter" key={tag}>{tag}</span>)}
          </div>
          {customers.map((item) => <CustomerCard customer={item} key={item.id} />)}
        </section>
      )}
      {mode === "customer" && customer && (
        <section className="mobileList">
          <div className="mobileCustomerHeader">
            <Avatar customer={customer} channel={customer.source ?? "phone"} />
            <div>
              <div className="mobileCustomerName">{customer.displayName ?? "New customer"}</div>
              <div className="mobileMeta">{customer.primaryPhone ?? customer.primaryEmail ?? "No contact info"}</div>
            </div>
          </div>
          <Info title="Phone" value={customer.primaryPhone} />
          <Info title="Email" value={customer.primaryEmail} />
          <Info title="Owner" value="Unassigned" />
          <Info title="Last contact" value={customer.lastMessageAt ? new Date(customer.lastMessageAt).toLocaleString() : ""} />
          <div className="mobilePanel">
            <h2>Tags</h2>
            <div className="mobileActions">{defaultTags.map((tag) => <button className="mobileQuickBtn" key={tag}>{tag}</button>)}</div>
          </div>
          <div className="mobilePanel">
            <h2>Notes</h2>
            <textarea rows={5} defaultValue={customer.notes?.[0]?.body ?? ""} placeholder="Customer notes" />
          </div>
          <div className="mobilePanel">
            <h2>Orders</h2>
            <p className="mobileMeta">Reserved for Shopify/order history.</p>
          </div>
        </section>
      )}
      {mode === "tasks" && (
        <section className="mobileList">
          <div className="mobilePanel">
            <h2>Create follow up</h2>
            <input className="mobileInput" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} placeholder="Tomorrow 3 PM call back" />
            <input className="mobileInput" value={taskDueAt} onChange={(event) => setTaskDueAt(event.target.value)} placeholder="Reminder time" />
            <button className="mobilePrimary" onClick={saveTask}>Save</button>
          </div>
          {tasks.map((task) => (
            <button className={task.done ? "mobileCard mobileTask done" : "mobileCard mobileTask"} key={task.id} onClick={() => toggleTask(task.id)}>
              {task.done ? <CheckCircle2 size={22} /> : <Circle size={22} />}
              <div className="mobileCardBody">
                <div className="mobileName">{task.title}</div>
                <div className="mobileMeta">{task.customerName ?? "No customer"} · {task.dueAt}</div>
              </div>
            </button>
          ))}
        </section>
      )}
      {mode === "me" && (
        <section className="mobileList">
          <div className="mobilePanel">
            <h2>My profile</h2>
            <p className="mobileMeta">Admin / Manager / Sales / Support permissions follow desktop CRM.</p>
          </div>
          <button className="mobileCard" onClick={() => Notification.requestPermission()}><Bell size={20} />Browser notification</button>
          <button className="mobileCard" onClick={() => alert("Password change is handled by web admin auth.")}><UserRound size={20} />Change password</button>
          <button className="mobilePrimary" style={{ margin: 10 }} onClick={() => { localStorage.removeItem(TOKEN_KEY); location.href = "/mobile/inbox"; }}>Log out</button>
        </section>
      )}
      <BottomNav active={mode} />
      {offline && <div className="mobileOffline">Network disconnected. Reconnecting...</div>}
    </main>
  );
}

async function api<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`${path} ${response.status}`);
  return response.json() as Promise<T>;
}

function MobileTop({ title, metrics, loading, onRefresh }: { title: string; metrics: { unread: number; waiting: number; todayNew: number }; loading: boolean; onRefresh: () => void }) {
  return (
    <header className="mobileTop">
      <div className="mobileTopRow">
        <div>
          <h1 className="mobileTitle">{title}</h1>
          <div className="mobileMeta">{loading ? "Syncing..." : "Unified omnichannel inbox"}</div>
        </div>
        <button className="mobileIconBtn" onClick={onRefresh}><Menu size={20} /></button>
      </div>
      <div className="mobileMetricRow">
        <div className="mobileMetric"><strong>{metrics.unread}</strong><span>Unread</span></div>
        <div className="mobileMetric"><strong>{metrics.waiting}</strong><span>Need reply</span></div>
        <div className="mobileMetric"><strong>{metrics.todayNew}</strong><span>New today</span></div>
      </div>
    </header>
  );
}

function ConversationCard({ conversation }: { conversation: Conversation }) {
  const latest = conversation.messages?.[0];
  return (
    <Link className="mobileCard" href={`/mobile/conversations/${conversation.id}`}>
      <Avatar customer={conversation.customer} channel={conversation.channel} />
      <div className="mobileCardBody">
        <div className="mobileRow">
          <span className="mobileName">{conversation.customer.displayName ?? conversation.customer.primaryPhone ?? "New customer"}</span>
          <span className="mobileTime">{formatTime(conversation.lastMessageAt)}</span>
        </div>
        <div className="mobilePreview">{latest?.text || attachmentText(latest)}</div>
        <div className="mobileRow">
          <span className="mobileChannel">{channelIcon(conversation.channel)} {channelNames[conversation.channel]}</span>
          {conversation.unreadCount > 0 && <span className="mobileUnread">{conversation.unreadCount}</span>}
        </div>
        <div className="mobileTagLine">{conversation.customer.tags?.map((item) => item.tag.name).join(", ") || "No tags"}</div>
      </div>
    </Link>
  );
}

function CustomerCard({ customer }: { customer: Customer }) {
  const latestConversation = customer.conversations?.[0];
  const href = latestConversation ? `/mobile/conversations/${latestConversation.id}` : `/mobile/customers/${customer.id}`;
  return (
    <Link className="mobileCard" href={href}>
      <Avatar customer={customer} channel={customer.source ?? "phone"} />
      <div className="mobileCardBody">
        <div className="mobileRow">
          <span className="mobileName">{customer.displayName ?? "New customer"}</span>
          <span className="mobileTime">{formatTime(customer.lastMessageAt)}</span>
        </div>
        <div className="mobilePreview">{customer.primaryPhone ?? customer.primaryEmail ?? "No contact info"}</div>
        <div className="mobileTagLine">{customer.tags?.map((item) => item.tag.name).join(", ") || "No tags"}</div>
      </div>
    </Link>
  );
}

function Avatar({ customer, channel }: { customer: Customer; channel: Channel }) {
  const name = customer.displayName ?? customer.primaryPhone ?? customer.primaryEmail ?? "C";
  return (
    <div className={`mobileAvatar ${channel}`}>
      {customer.avatarUrl ? <img src={customer.avatarUrl} alt="" /> : name.slice(0, 1).toUpperCase()}
    </div>
  );
}

function AttachmentPreview({ attachment }: { attachment: Attachment }) {
  const Icon = attachment.type === "image" ? ImageIcon : attachment.type === "audio" ? Mic : attachment.type === "video" ? Video : FileText;
  return <a className="mobileAttachment" href={attachment.url} target="_blank" rel="noreferrer"><Icon size={15} /> {attachment.fileName ?? attachment.type}</a>;
}

function Info({ title, value }: { title: string; value?: string | null }) {
  return <div className="mobilePanel"><h2>{title}</h2><p>{value || "Not set"}</p></div>;
}

function BottomNav({ active }: { active: Mode }) {
  return (
    <nav className="mobileBottomNav">
      <Link className={active === "inbox" || active === "conversation" ? "mobileNavItem active" : "mobileNavItem"} href="/mobile/inbox"><Mail size={21} />Messages</Link>
      <Link className={active === "customers" || active === "customer" ? "mobileNavItem active" : "mobileNavItem"} href="/mobile/customers"><Users size={21} />Customers</Link>
      <Link className={active === "tasks" ? "mobileNavItem active" : "mobileNavItem"} href="/mobile/tasks"><Bell size={21} />Follow up</Link>
      <Link className={active === "me" ? "mobileNavItem active" : "mobileNavItem"} href="/mobile/me"><UserRound size={21} />Mine</Link>
    </nav>
  );
}

function filterLabel(filter: Filter) {
  if (filter === "all") return "All";
  if (filter === "unread") return "Unread";
  if (filter === "mine") return "Assigned to me";
  return channelNames[filter];
}

function titleFor(mode: Mode) {
  if (mode === "customers" || mode === "customer") return "Customers";
  if (mode === "tasks") return "Follow up";
  if (mode === "me") return "Mine";
  return "Messages";
}

function formatTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const diff = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diff < 1) return "Now";
  if (diff < 60) return `${diff}m`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h`;
  return date.toLocaleDateString();
}

function attachmentText(message?: Message) {
  if (!message?.attachments?.length) return "No message";
  return `[${message.attachments[0].type}]`;
}

function channelIcon(channel: Channel) {
  if (channel === "whatsapp") return "WA";
  if (channel === "messenger") return "M";
  if (channel === "website_chat") return "WEB";
  if (channel === "instagram") return "IG";
  return channel.toUpperCase();
}

async function notify(title: string, body: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") await Notification.requestPermission();
  if (Notification.permission === "granted") new Notification(title, { body, icon: "/mobile-icon.svg" });
}

function playBeep() {
  const audio = new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=");
  audio.play().catch(() => undefined);
}
