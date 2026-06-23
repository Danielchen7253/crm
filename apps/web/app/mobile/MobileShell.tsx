"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  Bell,
  Bot,
  CheckCircle2,
  ChevronLeft,
  Circle,
  Copy,
  FileText,
  FileUp,
  ImageIcon,
  ImagePlus,
  Mail,
  Menu,
  Mic,
  MoreVertical,
  Paperclip,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  UserRound,
  Users,
  Video,
  X,
} from "lucide-react";
import { QueryClient, QueryClientProvider, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ClipboardEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import "./mobile.css";

const API_BASE = "/api/backend";
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? "https://coolfix-omni-api.onrender.com";
const DEFAULT_TOKEN = "development-token";
const TOKEN_KEY = "coolfix.crm.mobile.web.token";
const DRAFT_PREFIX = "coolfix.crm.mobile.draft.";
const TASK_KEY = "coolfix.crm.mobile.web.tasks";
const PAGE_SIZE = 30;
const mobileQueryClient = new QueryClient();

type Channel = "messenger" | "whatsapp" | "sms" | "instagram" | "email" | "website_chat" | "phone";
type Filter = "all" | "unread" | "mine" | Channel;
type Mode = "inbox" | "conversation" | "customers" | "customer" | "tasks" | "me";

type Attachment = {
  id: string;
  type: "image" | "audio" | "video" | "file";
  url: string;
  fileUrl?: string | null;
  fileName?: string | null;
  mimeType?: string | null;
  size?: number | null;
};

type Message = {
  id: string;
  temp_id?: string;
  conversation_id?: string;
  customer_id?: string;
  direction: "inbound" | "outbound" | "internal";
  sender_type?: string | null;
  channel?: Channel | null;
  type: string;
  status: string;
  text?: string | null;
  textContent?: string | null;
  text_content?: string | null;
  content_type?: string | null;
  providerErrorMessage?: string | null;
  sentAt: string;
  createdAt?: string | null;
  deliveredAt?: string | null;
  readAt?: string | null;
  failedReason?: string | null;
  attachments?: Attachment[];
  rawEvent?: unknown;
  aiReplyLogs?: { suggestedReply?: string | null; confidence?: number | null; action?: string | null; detectedLanguage?: string | null }[];
};

type MessagePage = {
  messages: Message[];
  nextCursor: string | null;
  hasMore: boolean;
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
    if (mode === "conversation") return;
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
  }, [conversationId, loadConversation, loadConversations, mode, token]);

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

  if (mode === "conversation") {
    return <MobileConversationProvider conversationId={conversationId ?? conversation?.id ?? ""} token={token} />;
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

function MobileConversationProvider({ conversationId, token }: { conversationId: string; token: string }) {
  return (
    <QueryClientProvider client={mobileQueryClient}>
      <MobileConversationScreen conversationId={conversationId} token={token} />
    </QueryClientProvider>
  );
}

function MobileConversationScreen({ conversationId, token }: { conversationId: string; token: string }) {
  const queryClient = useQueryClient();
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showNewMessage, setShowNewMessage] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousPosition = document.body.style.position;
    const previousWidth = document.body.style.width;
    document.body.style.overflow = "hidden";
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.body.style.position = previousPosition;
      document.body.style.width = previousWidth;
    };
  }, []);

  useEffect(() => {
    const shell = shellRef.current;
    const header = headerRef.current;
    const composer = composerRef.current;
    if (!shell || !header || !composer) return;

    const syncLayout = () => {
      shell.style.setProperty("--mobile-chat-header-height", `${Math.ceil(header.getBoundingClientRect().height)}px`);
      shell.style.setProperty("--mobile-chat-composer-height", `${Math.ceil(composer.getBoundingClientRect().height)}px`);
    };

    syncLayout();
    const observer = new ResizeObserver(syncLayout);
    observer.observe(header);
    observer.observe(composer);
    window.visualViewport?.addEventListener("resize", syncLayout);
    window.addEventListener("orientationchange", syncLayout);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener("resize", syncLayout);
      window.removeEventListener("orientationchange", syncLayout);
    };
  }, [draft, quickOpen, profileOpen]);

  const conversationQuery = useQuery({
    queryKey: ["mobile-conversation", conversationId],
    queryFn: () => api<Conversation>(`/conversations/${conversationId}`, token),
    enabled: Boolean(conversationId && token),
  });

  const quickRepliesQuery = useQuery({
    queryKey: ["mobile-quick-replies"],
    queryFn: () => api<QuickReply[]>("/quick-replies", token),
    enabled: Boolean(token),
  });

  const messagesQuery = useInfiniteQuery({
    queryKey: ["mobile-messages", conversationId],
    initialPageParam: undefined as string | undefined,
    enabled: Boolean(conversationId && token),
    queryFn: async ({ pageParam }) => {
      try {
        return await api<MessagePage>(`/conversations/${conversationId}/messages?limit=${PAGE_SIZE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, token);
      } catch {
        const fallback = await api<Conversation>(`/conversations/${conversationId}`, token);
        const allMessages = [...(fallback.messages ?? [])].sort((left, right) => new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime());
        return { messages: allMessages.slice(-PAGE_SIZE), nextCursor: allMessages[0]?.sentAt ?? null, hasMore: allMessages.length > PAGE_SIZE };
      }
    },
    getNextPageParam: (lastPage) => (lastPage.hasMore ? lastPage.nextCursor ?? undefined : undefined),
  });

  const messages = useMemo(() => {
    const rows = messagesQuery.data?.pages.flatMap((page) => page.messages) ?? [];
    const byId = new Map<string, Message>();
    for (const message of rows) byId.set(message.id, message);
    return [...byId.values()].sort((left, right) => new Date(left.sentAt).getTime() - new Date(right.sentAt).getTime());
  }, [messagesQuery.data]);

  const conversation = conversationQuery.data;
  const aiSuggestion = useMemo(() => {
    const logs = [...messages].reverse().flatMap((message) => message.aiReplyLogs ?? []);
    return logs.find((log) => log.action !== "no_reply" && log.suggestedReply);
  }, [messages]);

  const quickReplies = useMemo(() => {
    const loaded = quickRepliesQuery.data?.filter((reply) => reply.isActive && (!conversation || !reply.channel || reply.channel === conversation.channel)) ?? [];
    return loaded.length
      ? loaded
      : defaultQuickNames.map((name, index) => ({ id: `default-${index}`, name, channel: null, language: "en", content: name, isActive: true }));
  }, [conversation, quickRepliesQuery.data]);

  const sendMutation = useMutation({
    mutationFn: async (text: string) => {
      const payload = {
        conversation_id: conversationId,
        conversationId,
        channel: conversation?.channel,
        content_type: "text",
        text_content: text,
        attachment_ids: [],
      };
      return api<{ message: Message; failedReason?: string }>("/messages/send", token, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    },
    onMutate: async (text) => {
      await queryClient.cancelQueries({ queryKey: ["mobile-messages", conversationId] });
      const previous = queryClient.getQueryData<{ pages: MessagePage[]; pageParams: unknown[] }>(["mobile-messages", conversationId]);
      const tempMessage: Message = {
        id: `temp-${Date.now()}`,
        temp_id: `temp-${Date.now()}`,
        conversation_id: conversationId,
        customer_id: conversation?.customer.id,
        direction: "outbound",
        sender_type: "agent",
        channel: conversation?.channel,
        content_type: "text",
        type: "text",
        status: "queued",
        text,
        textContent: text,
        sentAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        attachments: [],
      } as Message;
      queryClient.setQueryData(["mobile-messages", conversationId], (old: { pages: MessagePage[]; pageParams: unknown[] } | undefined) => {
        if (!old?.pages.length) return { pages: [{ messages: [tempMessage], nextCursor: null, hasMore: false }], pageParams: [undefined] };
        const pages = [...old.pages];
        pages[pages.length - 1] = { ...pages[pages.length - 1], messages: [...pages[pages.length - 1].messages, tempMessage] };
        return { ...old, pages };
      });
      setDraft("");
      requestAnimationFrame(() => virtuosoRef.current?.scrollToIndex({ index: messages.length, align: "end", behavior: "smooth" }));
      return { previous, text };
    },
    onError: (_error, _text, context) => {
      if (context?.previous) queryClient.setQueryData(["mobile-messages", conversationId], context.previous);
      if (context?.text) setDraft(context.text);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["mobile-messages", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["mobile-conversation", conversationId] });
    },
  });

  const retryMutation = useMutation({
    mutationFn: (messageId: string) => api(`/messages/${messageId}/retry`, token, { method: "POST" }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["mobile-messages", conversationId] }),
  });

  useEffect(() => {
    if (!conversationId) return;
    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socket.on("connect", () => {
      setOffline(false);
      socket.emit("conversation.join", { conversationId });
    });
    socket.on("disconnect", () => setOffline(true));
    socket.on("message.created", (event: { conversationId?: string }) => {
      if (event.conversationId !== conversationId) return;
      void queryClient.invalidateQueries({ queryKey: ["mobile-messages", conversationId] });
      void queryClient.invalidateQueries({ queryKey: ["mobile-conversation", conversationId] });
      if (isAtBottom) {
        requestAnimationFrame(() => virtuosoRef.current?.scrollToIndex({ index: Math.max(messages.length - 1, 0), align: "end", behavior: "smooth" }));
      } else {
        setShowNewMessage(true);
      }
      playBeep();
    });
    socket.on("message.updated", (event: { conversationId?: string }) => {
      if (event.conversationId === conversationId) void queryClient.invalidateQueries({ queryKey: ["mobile-messages", conversationId] });
    });
    socket.on("message.status", (event: { conversationId?: string }) => {
      if (event.conversationId === conversationId) void queryClient.invalidateQueries({ queryKey: ["mobile-messages", conversationId] });
    });
    socket.on("conversation.read", (event: { conversationId?: string }) => {
      if (event.conversationId === conversationId) void queryClient.invalidateQueries({ queryKey: ["mobile-conversation", conversationId] });
    });
    socket.on("typing.started", (event: { conversationId?: string }) => {
      if (event.conversationId === conversationId) setTyping(true);
    });
    socket.on("typing.stopped", (event: { conversationId?: string }) => {
      if (event.conversationId === conversationId) setTyping(false);
    });
    return () => {
      socket.emit("conversation.leave", { conversationId });
      socket.disconnect();
    };
  }, [conversationId, isAtBottom, messages.length, queryClient]);

  useEffect(() => {
    if (!conversationId || !token) return;
    void api(`/conversations/${conversationId}/read`, token, { method: "POST" }).catch(() => undefined);
  }, [conversationId, token]);

  useEffect(() => {
    if (!messages.length) return;
    if (isAtBottom) requestAnimationFrame(() => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: "end" }));
  }, [conversationId, isAtBottom, messages.length]);

  function submitDraft() {
    const text = draft.trim();
    if (!text || sendMutation.isPending) return;
    sendMutation.mutate(text);
  }

  function insertText(text: string) {
    setDraft((current) => (current ? `${current}\n${text}` : text));
    requestAnimationFrame(() => textareaRef.current?.focus());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
    }
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const image = [...event.clipboardData.items].find((item) => item.type.startsWith("image/"));
    if (image) setOffline(false);
  }

  async function onPickFile(file?: File | null) {
    if (!file) return;
    const payload = new FormData();
    payload.append("file", file);
    const response = await fetch(`${API_BASE}/files/upload`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: payload,
    }).catch(() => null);
    if (!response?.ok) {
      setOffline(true);
      return;
    }
    setOffline(false);
  }

  if (!conversationId) {
    return <main className="mobileChat"><div className="mobileEmptyChat">Missing conversation.</div></main>;
  }

  const loading = conversationQuery.isLoading || messagesQuery.isLoading;

  return (
    <main ref={shellRef} className="mobileChat" onDragOver={(event) => event.preventDefault()} onDrop={(event) => event.preventDefault()}>
      <header ref={headerRef} className="mobileChatHeader">
        <Link className="mobileBackBtn" href="/mobile/inbox" aria-label="Back"><ChevronLeft size={22} /></Link>
        {conversation ? <button className="mobileAvatarButton" onClick={() => setProfileOpen(true)}><Avatar customer={conversation.customer} channel={conversation.channel} /></button> : <div className="mobileAvatar phone">C</div>}
        <button className="mobileChatInfo mobileChatInfoButton" onClick={() => setProfileOpen(true)}>
          <div className="mobileCustomerName">{conversation?.customer.displayName ?? conversation?.customer.primaryPhone ?? "Loading customer"}</div>
          <div className="mobileMeta">{conversation ? `${channelNames[conversation.channel]} · ${formatTime(conversation.lastMessageAt)}` : "Syncing messages..."}</div>
        </button>
        <button className="mobileIconBtn" onClick={() => setProfileOpen(true)} aria-label="More"><MoreVertical size={20} /></button>
      </header>

      <section className="mobileMessages mobileVirtuosoWrap">
        {loading ? (
          <div className="mobileChatSkeleton">
            <span /><span /><span /><span />
          </div>
        ) : (
          <Virtuoso
            ref={virtuosoRef}
            className="mobileVirtuoso"
            data={messages}
            startReached={() => {
              if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) void messagesQuery.fetchNextPage();
            }}
            atBottomStateChange={(bottom) => {
              setIsAtBottom(bottom);
              if (bottom) setShowNewMessage(false);
            }}
            followOutput={isAtBottom ? "smooth" : false}
            itemContent={(index, message) => (
              <MessageRow
                key={message.id}
                message={message}
                previous={messages[index - 1]}
                onCopy={() => void navigator.clipboard?.writeText(messageText(message))}
                onRetry={() => retryMutation.mutate(message.id)}
              />
            )}
            components={{
              Header: () => messagesQuery.isFetchingNextPage ? <div className="mobileHistoryLoading">Loading earlier messages...</div> : null,
              Footer: () => typing ? <div className="mobileTyping">Customer is typing...</div> : <div className="mobileListBottomSpace" />,
            }}
          />
        )}
        {showNewMessage && (
          <button className="mobileNewMessageBtn" onClick={() => virtuosoRef.current?.scrollToIndex({ index: Math.max(messages.length - 1, 0), align: "end", behavior: "smooth" })}>
            New messages
          </button>
        )}
      </section>

      <section ref={composerRef} className="mobileComposerWrap">
        {aiSuggestion?.suggestedReply && (
          <div className="mobileAi">
            <div className="mobileAiTitle"><Sparkles size={14} /> AI suggestion · {Math.round((aiSuggestion.confidence ?? 0) * 100)}%</div>
            <p>{aiSuggestion.suggestedReply}</p>
            <div className="mobileActions">
              <button className="mobileActionBtn" onClick={() => insertText(aiSuggestion.suggestedReply ?? "")}>Use</button>
              <button className="mobileActionBtn" onClick={() => setDraft(aiSuggestion.suggestedReply ?? "")}>Edit</button>
              <button className="mobileQuickBtn">Ignore</button>
            </div>
          </div>
        )}
        <div className="mobileComposerTools">
          <button className="mobileFileBtn" onClick={() => imageInputRef.current?.click()} aria-label="Upload image"><ImagePlus size={20} /></button>
          <button className="mobileFileBtn" onClick={() => fileInputRef.current?.click()} aria-label="Upload file"><FileUp size={20} /></button>
          <button className="mobileQuickBtn" onClick={() => setQuickOpen(true)}>Quick replies</button>
          <button className="mobileQuickBtn" onClick={() => aiSuggestion?.suggestedReply && insertText(aiSuggestion.suggestedReply)}>AI</button>
          <input ref={imageInputRef} type="file" accept="image/*" hidden onChange={(event) => void onPickFile(event.target.files?.[0])} />
          <input ref={fileInputRef} type="file" hidden onChange={(event) => void onPickFile(event.target.files?.[0])} />
        </div>
        <div className="mobileComposer">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Type reply"
            rows={1}
          />
          <button className="mobileSendBtn" onClick={submitDraft} disabled={!draft.trim() || sendMutation.isPending} aria-label="Send">
            {sendMutation.isPending ? <RefreshCw size={18} /> : <Send size={19} />}
          </button>
        </div>
      </section>

      {quickOpen && (
        <div className="mobileSheetBackdrop" onClick={() => setQuickOpen(false)}>
          <section className="mobileSheet" onClick={(event) => event.stopPropagation()}>
            <div className="mobileSheetHeader"><strong>Quick replies</strong><button className="mobileIconBtn" onClick={() => setQuickOpen(false)}><X size={18} /></button></div>
            {quickReplies.slice(0, 20).map((reply) => <button className="mobileSheetItem" key={reply.id} onClick={() => { insertText(reply.content); setQuickOpen(false); }}>{reply.name}<span>{reply.content}</span></button>)}
          </section>
        </div>
      )}

      {profileOpen && conversation && (
        <div className="mobileSheetBackdrop" onClick={() => setProfileOpen(false)}>
          <section className="mobileProfileSheet" onClick={(event) => event.stopPropagation()}>
            <div className="mobileSheetHeader"><strong>Customer</strong><button className="mobileIconBtn" onClick={() => setProfileOpen(false)}><X size={18} /></button></div>
            <div className="mobileCustomerHeader"><Avatar customer={conversation.customer} channel={conversation.channel} /><div><div className="mobileCustomerName">{conversation.customer.displayName ?? "New customer"}</div><div className="mobileMeta">{conversation.customer.primaryPhone ?? conversation.customer.primaryEmail ?? channelNames[conversation.channel]}</div></div></div>
            <Info title="Phone" value={conversation.customer.primaryPhone} />
            <Info title="Email" value={conversation.customer.primaryEmail} />
            <Info title="Owner" value={conversation.assignedTo?.name ?? "Unassigned"} />
            <Info title="Last contact" value={conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toLocaleString() : ""} />
            <div className="mobilePanel"><h2>Identities</h2>{conversation.customer.identities?.map((identity) => <p className="mobileMeta" key={identity.id}>{channelNames[identity.channel]} · {identity.phone ?? identity.email ?? identity.displayName ?? identity.externalId}</p>)}</div>
            <div className="mobilePanel"><h2>Tags</h2><p>{conversation.customer.tags?.map((item) => item.tag.name).join(", ") || "No tags"}</p></div>
            <div className="mobilePanel"><h2>Notes</h2><textarea rows={4} defaultValue={conversation.customer.notes?.[0]?.body ?? ""} placeholder="Customer notes" /></div>
          </section>
        </div>
      )}

      {offline && <div className="mobileOffline">Network disconnected. Reconnecting...</div>}
    </main>
  );
}

function MessageRow({ message, previous, onCopy, onRetry }: { message: Message; previous?: Message; onCopy: () => void; onRetry: () => void }) {
  const showDate = !previous || new Date(previous.sentAt).toDateString() !== new Date(message.sentAt).toDateString();
  const failed = message.status === "failed" || Boolean(message.failedReason || message.providerErrorMessage);
  const direction = message.direction === "outbound" ? "outbound" : "inbound";
  const attachments = normalizedAttachments(message);
  return (
    <>
      {showDate && <div className="mobileDateDivider"><span>{new Date(message.sentAt).toLocaleDateString()}</span></div>}
      <article className={`mobileBubble ${direction} ${failed ? "failed" : ""}`} onDoubleClick={onCopy}>
        {messageText(message) && <p>{messageText(message)}</p>}
        {attachments.map((attachment) => <AttachmentPreview attachment={attachment} key={attachment.id} />)}
        <div className="mobileBubbleMeta">
          <span>{formatTime(message.sentAt)}</span>
          <span>{message.channel ? channelNames[message.channel] : ""}</span>
          <span>{statusLabel(message.status)}</span>
        </div>
        {failed && (
          <div className="mobileFailure">
            <span>{failureText(message)}</span>
            <button onClick={onRetry}>Retry</button>
          </div>
        )}
        <button className="mobileCopyBtn" onClick={onCopy} title="Copy"><Copy size={13} /></button>
      </article>
    </>
  );
}

function messageText(message: Message) {
  return message.textContent ?? message.text_content ?? message.text ?? "";
}

function failureText(message: Message) {
  const reason = message.failedReason ?? message.providerErrorMessage ?? "Send failed";
  if (reason.includes("MESSENGER_PAGE_ACCESS_TOKEN")) {
    return "Messenger is not connected. Add a valid Page Access Token, then retry.";
  }
  if (reason.toLowerCase().includes("access token") && reason.toLowerCase().includes("expired")) {
    return "Messenger token expired. Reconnect Messenger, then retry.";
  }
  if (reason.includes("(#10)") || reason.toLowerCase().includes("messaging window") || reason.includes("消息发送时间窗")) {
    return "Outside Messenger 24-hour reply window. Wait for the customer to message again, then reply.";
  }
  return reason;
}

function normalizedAttachments(message: Message): Attachment[] {
  const persisted = (message.attachments ?? []).map((attachment) => ({
    ...attachment,
    url: attachment.url ?? attachment.fileUrl ?? "",
    type: attachment.type ?? attachmentKind(attachment.mimeType, attachment.fileName, attachment.url ?? attachment.fileUrl),
  })).filter((attachment) => attachment.url);
  const raw = message.rawEvent as Record<string, unknown> | undefined;
  const candidates = collectAttachmentCandidates(raw);
  const extracted = candidates
    .map((candidate, index) => attachmentFromRaw(candidate, `${message.id}-raw-${index}`))
    .filter((attachment): attachment is Attachment => Boolean(attachment?.url));
  const byUrl = new Map<string, Attachment>();
  for (const attachment of [...persisted, ...extracted]) byUrl.set(attachment.url, attachment);
  return [...byUrl.values()];
}

function collectAttachmentCandidates(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const results: Record<string, unknown>[] = [];
  if (typeof object.url === "string" || typeof object.file_url === "string" || typeof object.preview_url === "string" || typeof object.external_url === "string") {
    results.push(object);
  }
  for (const child of Object.values(object)) {
    if (Array.isArray(child)) {
      for (const item of child) results.push(...collectAttachmentCandidates(item));
    } else if (child && typeof child === "object") {
      results.push(...collectAttachmentCandidates(child));
    }
  }
  return results.slice(0, 12);
}

function attachmentFromRaw(raw: Record<string, unknown>, id: string): Attachment | null {
  const url = stringValue(raw.url) ?? stringValue(raw.file_url) ?? stringValue(raw.preview_url) ?? stringValue(raw.external_url);
  if (!url) return null;
  const mimeType = stringValue(raw.mime_type) ?? stringValue(raw.mimeType) ?? stringValue(raw.content_type);
  const fileName = stringValue(raw.file_name) ?? stringValue(raw.filename) ?? stringValue(raw.name) ?? stringValue(raw.title);
  return { id, url, fileName, mimeType, type: attachmentKind(mimeType, fileName, url) };
}

function stringValue(value: unknown) {
  return typeof value === "string" && value ? value : null;
}

function attachmentKind(mimeType?: string | null, fileName?: string | null, url?: string | null): Attachment["type"] {
  const probe = `${mimeType ?? ""} ${fileName ?? ""} ${url ?? ""}`.toLowerCase();
  if (probe.includes("image") || /\.(png|jpe?g|gif|webp|heic)([?#/]|$)/.test(probe)) return "image";
  if (probe.includes("audio") || /\.(mp3|m4a|wav|ogg|opus|aac)([?#/]|$)/.test(probe)) return "audio";
  if (probe.includes("video") || /\.(mp4|mov|webm|avi)([?#/]|$)/.test(probe)) return "video";
  return "file";
}

function statusLabel(status: string) {
  if (status === "queued") return "sending";
  if (status === "sent") return "sent";
  if (status === "delivered") return "delivered";
  if (status === "read") return "read";
  if (status === "failed") return "failed";
  return status;
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
  if (attachment.type === "image") {
    return <a className="mobileAttachmentImage" href={attachment.url} target="_blank" rel="noreferrer"><img src={attachment.url} alt={attachment.fileName ?? "image attachment"} /></a>;
  }
  if (attachment.type === "audio") {
    return <audio className="mobileAttachmentPlayer" src={attachment.url} controls preload="metadata" />;
  }
  if (attachment.type === "video") {
    return <video className="mobileAttachmentPlayer" src={attachment.url} controls preload="metadata" />;
  }
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
  const attachments = message ? normalizedAttachments(message) : [];
  if (!attachments.length) return "No message";
  return `[${attachments[0].type}]`;
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

