import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { io, Socket } from "socket.io-client";

type Channel = "messenger" | "whatsapp" | "sms" | "instagram" | "email" | "website_chat" | "phone";
type TabKey = "dashboard" | "inbox" | "customers" | "tasks" | "profile";
type InboxFilter = "all" | "unread" | "mine" | Channel;

type Tag = {
  tag: {
    name: string;
    color?: string | null;
  };
};

type Identity = {
  id: string;
  channel: Channel;
  externalId: string;
  phone?: string | null;
  email?: string | null;
  displayName?: string | null;
};

type Customer = {
  id: string;
  displayName?: string | null;
  primaryPhone?: string | null;
  primaryEmail?: string | null;
  source?: Channel | null;
  avatarUrl?: string | null;
  lastMessageAt?: string | null;
  tags?: Tag[];
  identities?: Identity[];
  notes?: { id: string; body: string; createdAt: string }[];
};

type AiReplyLog = {
  suggestedReply: string;
  confidence: number;
  action: "suggest_reply" | "ask_human" | "no_reply";
  intent: string;
  detectedLanguage: string;
};

type Attachment = {
  id: string;
  type: "image" | "audio" | "video" | "file";
  url: string;
  fileName?: string | null;
  mimeType?: string | null;
};

type Message = {
  id: string;
  channel: Channel;
  direction: "inbound" | "outbound" | "internal";
  type: "text" | "image" | "audio" | "video" | "file" | "template" | "system";
  status: "received" | "queued" | "sent" | "delivered" | "read" | "failed";
  text?: string | null;
  sentAt: string;
  failedReason?: string | null;
  attachments?: Attachment[];
  aiReplyLogs?: AiReplyLog[];
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

type FollowUpTask = {
  id: string;
  title: string;
  customerName?: string;
  dueAt: string;
  done: boolean;
};

const extra = Constants.expoConfig?.extra as { apiBaseUrl?: string; socketUrl?: string } | undefined;
const API_BASE = extra?.apiBaseUrl ?? "https://coolfix-omni-api.onrender.com/api";
const SOCKET_URL = extra?.socketUrl ?? "https://coolfix-omni-api.onrender.com";
const TOKEN_KEY = "coolfix.crm.mobile.token";
const USER_KEY = "coolfix.crm.mobile.user";
const LOCAL_TASKS_KEY = "coolfix.crm.mobile.tasks";

const channelLabels: Record<Channel, string> = {
  messenger: "Messenger",
  whatsapp: "WhatsApp",
  sms: "SMS",
  instagram: "Instagram",
  email: "Email",
  website_chat: "Website",
  phone: "Phone",
};

const channelColors: Record<Channel, string> = {
  messenger: "#0A7CFF",
  whatsapp: "#1FA855",
  sms: "#6B7280",
  instagram: "#D62976",
  email: "#7C3AED",
  website_chat: "#0F766E",
  phone: "#334155",
};

const defaultTags = ["VIP", "Wholesale", "HVAC", "Refrigeration", "Follow Up", "Customer", "Supplier"];

export default function App() {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<{ name: string; email?: string; phone?: string } | null>(null);
  const [loginMode, setLoginMode] = useState<"email" | "phone">("email");
  const [loginValue, setLoginValue] = useState("");
  const [activeTab, setActiveTab] = useState<TabKey>("inbox");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(false);
  const [tasks, setTasks] = useState<FollowUpTask[]>([]);
  const [taskDraft, setTaskDraft] = useState("");
  const [taskDueAt, setTaskDueAt] = useState("");

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedConversationId) ?? null,
    [conversations, selectedConversationId],
  );

  const latestAiSuggestion = useMemo(() => {
    const messages = [...(selectedConversation?.messages ?? [])].reverse();
    return messages.flatMap((message) => message.aiReplyLogs ?? []).find((log) => log.action === "suggest_reply") ?? null;
  }, [selectedConversation]);

  const dashboard = useMemo(() => {
    const today = new Date().toDateString();
    const todaysConversations = conversations.filter((conversation) =>
      conversation.lastMessageAt ? new Date(conversation.lastMessageAt).toDateString() === today : false,
    );
    return {
      todayNewCustomers: customers.filter((customer) => customer.lastMessageAt && new Date(customer.lastMessageAt).toDateString() === today).length,
      unreadMessages: conversations.reduce((sum, conversation) => sum + conversation.unreadCount, 0),
      waitingReplies: conversations.filter((conversation) => conversation.messages?.[0]?.direction === "inbound").length,
      todayMessages: todaysConversations.length,
      myCustomers: customers.length,
      recentCustomers: customers.slice(0, 5),
    };
  }, [conversations, customers]);

  const filteredConversations = useMemo(() => {
    return conversations.filter((conversation) => {
      if (filter === "unread" && conversation.unreadCount <= 0) return false;
      if (filter === "mine" && !conversation.assignedTo) return false;
      if (filter !== "all" && filter !== "unread" && filter !== "mine" && conversation.channel !== filter) return false;
      if (!search.trim()) return true;
      const term = search.trim().toLowerCase();
      const customer = conversation.customer;
      const latest = conversation.messages?.[0]?.text ?? "";
      return [customer.displayName, customer.primaryPhone, customer.primaryEmail, latest]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(term));
    });
  }, [conversations, filter, search]);

  const customerResults = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return customers;
    return customers.filter((customer) => {
      const tagText = customer.tags?.map((item) => item.tag.name).join(" ") ?? "";
      return [customer.displayName, customer.primaryPhone, customer.primaryEmail, tagText].filter(Boolean).some((value) => String(value).toLowerCase().includes(term));
    });
  }, [customers, search]);

  const restoreSession = async () => {
    const storedToken = await AsyncStorage.getItem(TOKEN_KEY);
    const storedUser = await AsyncStorage.getItem(USER_KEY);
    if (storedToken) setToken(storedToken);
    if (storedUser) setUser(JSON.parse(storedUser));
  };

  async function request<T>(path: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(options?.headers ?? {}),
      },
    });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json() as Promise<T>;
  }

  const loadConversations = useCallback(async () => {
    const params = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "";
    const data = await request<Conversation[]>(`/conversations${params}`);
    setConversations(data);
    if (!selectedConversationId && data[0]) setSelectedConversationId(data[0].id);
  }, [search, selectedConversationId, token]);

  const loadConversationDetail = useCallback(async (id: string) => {
    const detail = await request<Conversation | null>(`/conversations/${id}`);
    if (!detail) return;
    setConversations((current) => current.map((item) => (item.id === id ? detail : item)));
    setSelectedConversationId(id);
  }, [token]);

  const loadCustomers = useCallback(async () => {
    const params = search.trim() ? `?q=${encodeURIComponent(search.trim())}` : "";
    setCustomers(await request<Customer[]>(`/customers${params}`));
  }, [search, token]);

  const loadQuickReplies = useCallback(async () => {
    setQuickReplies(await request<QuickReply[]>("/quick-replies"));
  }, [token]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadConversations(), loadCustomers(), loadQuickReplies()]);
    } catch (error) {
      Alert.alert("Sync failed", error instanceof Error ? error.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [loadConversations, loadCustomers, loadQuickReplies]);

  const loadLocalTasks = async () => {
    const raw = await AsyncStorage.getItem(LOCAL_TASKS_KEY);
    setTasks(raw ? JSON.parse(raw) : []);
  };

  const saveTasks = async (next: FollowUpTask[]) => {
    setTasks(next);
    await AsyncStorage.setItem(LOCAL_TASKS_KEY, JSON.stringify(next));
  };

  const login = async (provider?: "google" | "facebook") => {
    const value = provider ? `${provider}@coolfixpro.com` : loginValue.trim();
    if (!value) {
      Alert.alert("Login", "Enter email or phone.");
      return;
    }
    const payload = loginMode === "phone" && !provider ? { email: `${value.replace(/\D/g, "")}@phone.coolfixpro.com` } : { email: value };
    const result = await request<{ accessToken: string; user: { name: string; email?: string; phone?: string } }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await AsyncStorage.setItem(TOKEN_KEY, result.accessToken);
    await AsyncStorage.setItem(USER_KEY, JSON.stringify(result.user));
    setToken(result.accessToken);
    setUser(result.user);
    setActiveTab("inbox");
  };

  const logout = async () => {
    await AsyncStorage.multiRemove([TOKEN_KEY, USER_KEY]);
    setToken(null);
    setUser(null);
  };

  const sendMessage = async (text = draft) => {
    if (!selectedConversation || !text.trim()) return;
    const body = { conversationId: selectedConversation.id, text: text.trim() };
    const result = await request<{ failedReason?: string }>("/messages/send", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (result.failedReason) Alert.alert("Send failed", result.failedReason);
    setDraft("");
    await loadConversationDetail(selectedConversation.id);
  };

  const addTask = async () => {
    if (!taskDraft.trim()) return;
    const next = [
      {
        id: `${Date.now()}`,
        title: taskDraft.trim(),
        customerName: selectedConversation?.customer.displayName ?? selectedCustomer?.displayName ?? undefined,
        dueAt: taskDueAt.trim() || "Tomorrow 3:00 PM",
        done: false,
      },
      ...tasks,
    ];
    await saveTasks(next);
    setTaskDraft("");
    setTaskDueAt("");
  };

  const toggleTask = async (id: string) => {
    await saveTasks(tasks.map((task) => (task.id === id ? { ...task, done: !task.done } : task)));
  };

  const registerPushNotifications = async () => {
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) await Notifications.requestPermissionsAsync();
  };

  const notifyNewMessage = async () => {
    await Notifications.scheduleNotificationAsync({
      content: { title: "New customer message", body: "Open CRM Mobile to reply." },
      trigger: null,
    });
  };

  useEffect(() => {
    void restoreSession();
    void loadLocalTasks();
  }, []);

  useEffect(() => {
    if (!token) return;
    void loadAll();
    void registerPushNotifications();

    const socket: Socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socket.on("message.created", () => {
      void loadConversations();
      void notifyNewMessage();
    });
    return () => {
      socket.disconnect();
    };
  }, [token, loadAll, loadConversations]);

  if (!token) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="dark" />
        <View style={styles.loginWrap}>
          <Text style={styles.logo}>CRM Mobile</Text>
          <Text style={styles.loginSub}>CoolFix unified customer inbox</Text>
          <View style={styles.segment}>
            <Pressable style={[styles.segmentItem, loginMode === "email" && styles.segmentActive]} onPress={() => setLoginMode("email")}>
              <Text style={[styles.segmentText, loginMode === "email" && styles.segmentTextActive]}>Email</Text>
            </Pressable>
            <Pressable style={[styles.segmentItem, loginMode === "phone" && styles.segmentActive]} onPress={() => setLoginMode("phone")}>
              <Text style={[styles.segmentText, loginMode === "phone" && styles.segmentTextActive]}>Phone</Text>
            </Pressable>
          </View>
          <TextInput
            style={styles.input}
            value={loginValue}
            onChangeText={setLoginValue}
            autoCapitalize="none"
            keyboardType={loginMode === "phone" ? "phone-pad" : "email-address"}
            placeholder={loginMode === "phone" ? "Phone number" : "Email address"}
          />
          <Pressable style={styles.primaryButton} onPress={() => void login()}>
            <Text style={styles.primaryButtonText}>Log in</Text>
          </Pressable>
          <View style={styles.oauthRow}>
            <Pressable style={styles.oauthButton} onPress={() => void login("google")}>
              <Text style={styles.oauthText}>Google</Text>
            </Pressable>
            <Pressable style={styles.oauthButton} onPress={() => void login("facebook")}>
              <Text style={styles.oauthText}>Facebook</Text>
            </Pressable>
          </View>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.topBar}>
          <View>
            <Text style={styles.topTitle}>{topTitle(activeTab)}</Text>
            <Text style={styles.topMeta}>{loading ? "Syncing..." : `${conversations.length} conversations`}</Text>
          </View>
          <Pressable style={styles.iconButton} onPress={() => void loadAll()}>
            {loading ? <ActivityIndicator /> : <Ionicons name="refresh" size={20} color="#111827" />}
          </Pressable>
        </View>

        {activeTab === "dashboard" && (
          <ScrollView style={styles.content}>
            <View style={styles.metricGrid}>
              <Metric title="Today new" value={dashboard.todayNewCustomers} />
              <Metric title="Unread" value={dashboard.unreadMessages} />
              <Metric title="Need reply" value={dashboard.waitingReplies} />
              <Metric title="Today msg" value={dashboard.todayMessages} />
              <Metric title="My customers" value={dashboard.myCustomers} />
            </View>
            <Text style={styles.sectionTitle}>Recent customers</Text>
            {dashboard.recentCustomers.map((customer) => (
              <CustomerRow key={customer.id} customer={customer} onPress={() => {
                setSelectedCustomer(customer);
                setActiveTab("customers");
              }} />
            ))}
          </ScrollView>
        )}

        {activeTab === "inbox" && (
          <View style={styles.content}>
            <Search value={search} onChange={setSearch} onSubmit={() => void loadAll()} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filters}>
              {(["all", "unread", "mine", "messenger", "whatsapp", "sms", "instagram", "email", "website_chat"] as InboxFilter[]).map((item) => (
                <Pressable key={item} style={[styles.filterPill, filter === item && styles.filterPillActive]} onPress={() => setFilter(item)}>
                  <Text style={[styles.filterText, filter === item && styles.filterTextActive]}>{filterLabel(item)}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <FlatList
              data={filteredConversations}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => <ConversationRow conversation={item} onPress={() => void loadConversationDetail(item.id)} />}
            />
            <ChatModal
              conversation={selectedConversation}
              aiSuggestion={latestAiSuggestion}
              draft={draft}
              setDraft={setDraft}
              quickReplies={quickReplies}
              onClose={() => setSelectedConversationId(null)}
              onSend={(text) => void sendMessage(text)}
              onTask={() => setActiveTab("tasks")}
            />
          </View>
        )}

        {activeTab === "customers" && (
          <View style={styles.content}>
            <Search value={search} onChange={setSearch} onSubmit={() => void loadCustomers()} />
            <FlatList
              data={customerResults}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => <CustomerRow customer={item} onPress={() => setSelectedCustomer(item)} />}
              ListHeaderComponent={<TagBar />}
            />
            <CustomerModal customer={selectedCustomer} onClose={() => setSelectedCustomer(null)} />
          </View>
        )}

        {activeTab === "tasks" && (
          <View style={styles.content}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Create follow up</Text>
              <TextInput style={styles.input} value={taskDraft} onChangeText={setTaskDraft} placeholder="Tomorrow 3 PM call back" />
              <TextInput style={styles.input} value={taskDueAt} onChangeText={setTaskDueAt} placeholder="Reminder time" />
              <Pressable style={styles.primaryButton} onPress={() => void addTask()}>
                <Text style={styles.primaryButtonText}>Save task</Text>
              </Pressable>
            </View>
            <FlatList
              data={tasks}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => (
                <Pressable style={styles.taskRow} onPress={() => void toggleTask(item.id)}>
                  <Ionicons name={item.done ? "checkmark-circle" : "ellipse-outline"} size={22} color={item.done ? "#16A34A" : "#64748B"} />
                  <View style={styles.flex}>
                    <Text style={[styles.taskTitle, item.done && styles.done]}>{item.title}</Text>
                    <Text style={styles.metaText}>{item.customerName ?? "No customer"} · {item.dueAt}</Text>
                  </View>
                </Pressable>
              )}
            />
          </View>
        )}

        {activeTab === "profile" && (
          <ScrollView style={styles.content}>
            <View style={styles.profileCard}>
              <Avatar name={user?.name ?? "User"} channel="phone" />
              <Text style={styles.profileName}>{user?.name ?? "User"}</Text>
              <Text style={styles.metaText}>{user?.email ?? user?.phone ?? "Admin / Sales / Support"}</Text>
            </View>
            <ProfileItem icon="lock-closed-outline" label="Change password" />
            <ProfileItem icon="cloud-upload-outline" label="File center" />
            <ProfileItem icon="notifications-outline" label="Push notification settings" />
            <Pressable style={styles.logoutButton} onPress={() => void logout()}>
              <Text style={styles.logoutText}>Log out</Text>
            </Pressable>
          </ScrollView>
        )}

        <View style={styles.bottomNav}>
          <NavButton tab="dashboard" active={activeTab} icon="grid-outline" label="Home" onPress={setActiveTab} />
          <NavButton tab="inbox" active={activeTab} icon="chatbubbles-outline" label="Messages" onPress={setActiveTab} />
          <NavButton tab="customers" active={activeTab} icon="people-outline" label="Customers" onPress={setActiveTab} />
          <NavButton tab="tasks" active={activeTab} icon="alarm-outline" label="Tasks" onPress={setActiveTab} />
          <NavButton tab="profile" active={activeTab} icon="person-outline" label="Mine" onPress={setActiveTab} />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function topTitle(tab: TabKey) {
  if (tab === "dashboard") return "Dashboard";
  if (tab === "customers") return "Customers";
  if (tab === "tasks") return "Follow up";
  if (tab === "profile") return "Mine";
  return "Inbox";
}

function filterLabel(filter: InboxFilter) {
  if (filter === "all") return "All";
  if (filter === "unread") return "Unread";
  if (filter === "mine") return "Mine";
  return channelLabels[filter];
}

function formatTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function Metric({ title, value }: { title: string; value: number }) {
  return (
    <View style={styles.metricCard}>
      <Text style={styles.metricValue}>{value}</Text>
      <Text style={styles.metricTitle}>{title}</Text>
    </View>
  );
}

function Search({ value, onChange, onSubmit }: { value: string; onChange: (value: string) => void; onSubmit: () => void }) {
  return (
    <View style={styles.searchBox}>
      <Ionicons name="search-outline" size={18} color="#64748B" />
      <TextInput style={styles.searchInput} value={value} onChangeText={onChange} onSubmitEditing={onSubmit} placeholder="Search name, phone, email, tag, message" />
    </View>
  );
}

function ConversationRow({ conversation, onPress }: { conversation: Conversation; onPress: () => void }) {
  const latest = conversation.messages?.[0];
  return (
    <Pressable style={styles.conversationRow} onPress={onPress}>
      <Avatar name={conversation.customer.displayName ?? "Customer"} channel={conversation.channel} />
      <View style={styles.flex}>
        <View style={styles.rowBetween}>
          <Text style={styles.rowTitle} numberOfLines={1}>{conversation.customer.displayName ?? "New customer"}</Text>
          <Text style={styles.timeText}>{formatTime(conversation.lastMessageAt)}</Text>
        </View>
        <View style={styles.rowBetween}>
          <Text style={styles.previewText} numberOfLines={1}>{latest?.text || attachmentLabel(latest)}</Text>
          {conversation.unreadCount > 0 && <Text style={styles.unreadBadge}>{conversation.unreadCount}</Text>}
        </View>
        <Text style={[styles.channelText, { color: channelColors[conversation.channel] }]}>{channelLabels[conversation.channel]}</Text>
      </View>
    </Pressable>
  );
}

function CustomerRow({ customer, onPress }: { customer: Customer; onPress: () => void }) {
  return (
    <Pressable style={styles.conversationRow} onPress={onPress}>
      <Avatar name={customer.displayName ?? "Customer"} channel={customer.source ?? "phone"} />
      <View style={styles.flex}>
        <View style={styles.rowBetween}>
          <Text style={styles.rowTitle}>{customer.displayName ?? "New customer"}</Text>
          <Text style={styles.timeText}>{formatTime(customer.lastMessageAt)}</Text>
        </View>
        <Text style={styles.previewText}>{customer.primaryPhone ?? customer.primaryEmail ?? "No contact info"}</Text>
        <Text style={styles.tagLine}>{customer.tags?.map((item) => item.tag.name).join(", ") || "No tags"}</Text>
      </View>
    </Pressable>
  );
}

function Avatar({ name, channel }: { name: string; channel: Channel }) {
  return (
    <View style={[styles.avatar, { backgroundColor: channelColors[channel] }]}>
      <Text style={styles.avatarText}>{name.trim().charAt(0).toUpperCase() || "C"}</Text>
    </View>
  );
}

function attachmentLabel(message?: Message) {
  if (!message?.attachments?.length) return "No message";
  const type = message.attachments[0].type;
  if (type === "image") return "Image";
  if (type === "audio") return "Voice";
  if (type === "video") return "Video";
  return "File";
}

function ChatModal({
  conversation,
  aiSuggestion,
  draft,
  setDraft,
  quickReplies,
  onClose,
  onSend,
  onTask,
}: {
  conversation: Conversation | null;
  aiSuggestion: AiReplyLog | null;
  draft: string;
  setDraft: (value: string) => void;
  quickReplies: QuickReply[];
  onClose: () => void;
  onSend: (text?: string) => void;
  onTask: () => void;
}) {
  return (
    <Modal visible={Boolean(conversation)} animationType="slide">
      <SafeAreaView style={styles.safe}>
        {conversation && (
          <KeyboardAvoidingView style={styles.app} behavior={Platform.OS === "ios" ? "padding" : undefined}>
            <View style={styles.chatHeader}>
              <Pressable onPress={onClose} style={styles.iconButton}>
                <Ionicons name="chevron-back" size={22} color="#111827" />
              </Pressable>
              <Avatar name={conversation.customer.displayName ?? "Customer"} channel={conversation.channel} />
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>{conversation.customer.displayName ?? "New customer"}</Text>
                <Text style={[styles.channelText, { color: channelColors[conversation.channel] }]}>{channelLabels[conversation.channel]}</Text>
              </View>
              <Pressable onPress={onTask} style={styles.iconButton}>
                <Ionicons name="alarm-outline" size={20} color="#111827" />
              </Pressable>
            </View>

            <ScrollView style={styles.messages}>
              {(conversation.messages ?? []).map((message) => (
                <Pressable
                  key={message.id}
                  onLongPress={() => Alert.alert("Message", "Copy, forward, and local hide actions are reserved for native build.")}
                  style={[styles.bubble, message.direction === "outbound" ? styles.outbound : styles.inbound]}
                >
                  <Text style={styles.messageText}>{message.text || attachmentLabel(message)}</Text>
                  {message.attachments?.map((attachment) => (
                    <Pressable key={attachment.id} onPress={() => Linking.openURL(attachment.url)}>
                      <Text style={styles.attachmentText}>{attachment.type.toUpperCase()} {attachment.fileName ?? ""}</Text>
                    </Pressable>
                  ))}
                  <Text style={styles.messageMeta}>{formatTime(message.sentAt)} · {message.status}</Text>
                </Pressable>
              ))}
            </ScrollView>

            {aiSuggestion && (
              <View style={styles.aiCard}>
                <Text style={styles.aiTitle}>AI suggestion · {Math.round(aiSuggestion.confidence * 100)}%</Text>
                <Text style={styles.aiText}>{aiSuggestion.suggestedReply}</Text>
                <View style={styles.actionRow}>
                  <Pressable style={styles.smallButton} onPress={() => onSend(aiSuggestion.suggestedReply)}>
                    <Text style={styles.smallButtonText}>Send</Text>
                  </Pressable>
                  <Pressable style={styles.smallButtonGhost} onPress={() => setDraft(aiSuggestion.suggestedReply)}>
                    <Text style={styles.smallButtonGhostText}>Edit</Text>
                  </Pressable>
                  <Pressable style={styles.smallButtonGhost}>
                    <Text style={styles.smallButtonGhostText}>Ignore</Text>
                  </Pressable>
                </View>
              </View>
            )}

            <ScrollView horizontal style={styles.quickReplyRail} showsHorizontalScrollIndicator={false}>
              {quickReplies.filter((item) => item.isActive && (!item.channel || item.channel === conversation.channel)).slice(0, 12).map((reply) => (
                <Pressable key={reply.id} style={styles.quickReply} onPress={() => setDraft(reply.content)}>
                  <Text style={styles.quickReplyText}>{reply.name}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.composer}>
              <Pressable style={styles.iconButton}>
                <Ionicons name="attach-outline" size={22} color="#111827" />
              </Pressable>
              <TextInput style={styles.composerInput} value={draft} onChangeText={setDraft} placeholder="Message" multiline />
              <Pressable style={styles.sendButton} onPress={() => onSend()}>
                <Ionicons name="send" size={19} color="#FFFFFF" />
              </Pressable>
            </View>
          </KeyboardAvoidingView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function CustomerModal({ customer, onClose }: { customer: Customer | null; onClose: () => void }) {
  return (
    <Modal visible={Boolean(customer)} animationType="slide">
      <SafeAreaView style={styles.safe}>
        {customer && (
          <ScrollView style={styles.content}>
            <View style={styles.chatHeader}>
              <Pressable onPress={onClose} style={styles.iconButton}>
                <Ionicons name="chevron-back" size={22} color="#111827" />
              </Pressable>
              <Avatar name={customer.displayName ?? "Customer"} channel={customer.source ?? "phone"} />
              <View style={styles.flex}>
                <Text style={styles.rowTitle}>{customer.displayName ?? "New customer"}</Text>
                <Text style={styles.metaText}>{customer.source ? channelLabels[customer.source] : "Customer"}</Text>
              </View>
            </View>
            <Info label="Phone" value={customer.primaryPhone} />
            <Info label="Email" value={customer.primaryEmail} />
            <Info label="Owner" value="Unassigned" />
            <Info label="Last contact" value={customer.lastMessageAt ? new Date(customer.lastMessageAt).toLocaleString() : ""} />
            <Info label="History messages" value={String(customer.identities?.length ?? 0)} />
            <Text style={styles.sectionTitle}>Tags</Text>
            <View style={styles.tagWrap}>
              {defaultTags.map((tag) => <Text key={tag} style={styles.tagChip}>{tag}</Text>)}
            </View>
            <Text style={styles.sectionTitle}>Notes</Text>
            <TextInput style={styles.noteInput} placeholder="Customer notes" multiline defaultValue={customer.notes?.[0]?.body ?? ""} />
          </ScrollView>
        )}
      </SafeAreaView>
    </Modal>
  );
}

function Info({ label, value }: { label: string; value?: string | null }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value || "Not set"}</Text>
    </View>
  );
}

function TagBar() {
  return (
    <ScrollView horizontal style={styles.filters} showsHorizontalScrollIndicator={false}>
      {defaultTags.map((tag) => <Text key={tag} style={styles.filterPill}>{tag}</Text>)}
    </ScrollView>
  );
}

function ProfileItem({ icon, label }: { icon: keyof typeof Ionicons.glyphMap; label: string }) {
  return (
    <Pressable style={styles.profileItem}>
      <Ionicons name={icon} size={20} color="#334155" />
      <Text style={styles.profileItemText}>{label}</Text>
      <Ionicons name="chevron-forward" size={18} color="#94A3B8" />
    </Pressable>
  );
}

function NavButton({ tab, active, icon, label, onPress }: { tab: TabKey; active: TabKey; icon: keyof typeof Ionicons.glyphMap; label: string; onPress: (tab: TabKey) => void }) {
  const selected = tab === active;
  return (
    <Pressable style={styles.navItem} onPress={() => onPress(tab)}>
      <Ionicons name={icon} size={22} color={selected ? "#0F172A" : "#94A3B8"} />
      <Text style={[styles.navText, selected && styles.navTextActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#F8FAFC" },
  app: { flex: 1 },
  loginWrap: { flex: 1, justifyContent: "center", padding: 24, gap: 14 },
  logo: { fontSize: 34, fontWeight: "800", color: "#0F172A" },
  loginSub: { fontSize: 15, color: "#64748B", marginBottom: 12 },
  segment: { flexDirection: "row", backgroundColor: "#E2E8F0", borderRadius: 8, padding: 4 },
  segmentItem: { flex: 1, alignItems: "center", paddingVertical: 10, borderRadius: 6 },
  segmentActive: { backgroundColor: "#FFFFFF" },
  segmentText: { color: "#64748B", fontWeight: "700" },
  segmentTextActive: { color: "#0F172A" },
  input: { backgroundColor: "#FFFFFF", borderColor: "#CBD5E1", borderWidth: 1, borderRadius: 8, minHeight: 48, paddingHorizontal: 12, color: "#0F172A" },
  primaryButton: { backgroundColor: "#0F172A", borderRadius: 8, minHeight: 48, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  primaryButtonText: { color: "#FFFFFF", fontWeight: "800" },
  oauthRow: { flexDirection: "row", gap: 10 },
  oauthButton: { flex: 1, backgroundColor: "#FFFFFF", borderColor: "#CBD5E1", borderWidth: 1, borderRadius: 8, minHeight: 46, alignItems: "center", justifyContent: "center" },
  oauthText: { color: "#0F172A", fontWeight: "700" },
  topBar: { minHeight: 66, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomColor: "#E2E8F0", borderBottomWidth: 1, backgroundColor: "#FFFFFF" },
  topTitle: { fontSize: 22, fontWeight: "800", color: "#0F172A" },
  topMeta: { fontSize: 12, color: "#64748B", marginTop: 2 },
  iconButton: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "#F1F5F9" },
  content: { flex: 1, padding: 12 },
  metricGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  metricCard: { width: "48%", backgroundColor: "#FFFFFF", borderRadius: 8, padding: 14, borderColor: "#E2E8F0", borderWidth: 1 },
  metricValue: { fontSize: 28, fontWeight: "800", color: "#0F172A" },
  metricTitle: { fontSize: 13, color: "#64748B", marginTop: 4 },
  sectionTitle: { fontSize: 16, fontWeight: "800", color: "#0F172A", marginTop: 18, marginBottom: 8 },
  searchBox: { flexDirection: "row", alignItems: "center", backgroundColor: "#FFFFFF", borderRadius: 8, borderColor: "#E2E8F0", borderWidth: 1, paddingHorizontal: 10, minHeight: 44, marginBottom: 8 },
  searchInput: { flex: 1, paddingHorizontal: 8, color: "#0F172A" },
  filters: { maxHeight: 44, marginBottom: 8 },
  filterPill: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 18, backgroundColor: "#E2E8F0", color: "#334155", marginRight: 8, overflow: "hidden" },
  filterPillActive: { backgroundColor: "#0F172A" },
  filterText: { fontSize: 13, fontWeight: "700", color: "#334155" },
  filterTextActive: { color: "#FFFFFF" },
  conversationRow: { flexDirection: "row", gap: 12, padding: 12, backgroundColor: "#FFFFFF", borderRadius: 8, borderColor: "#E2E8F0", borderWidth: 1, marginBottom: 8 },
  avatar: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#FFFFFF", fontSize: 18, fontWeight: "800" },
  flex: { flex: 1 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  rowTitle: { fontSize: 15, fontWeight: "800", color: "#0F172A", flexShrink: 1 },
  timeText: { fontSize: 12, color: "#64748B" },
  previewText: { fontSize: 13, color: "#475569", marginTop: 4, flex: 1 },
  unreadBadge: { minWidth: 22, height: 22, borderRadius: 11, backgroundColor: "#DC2626", color: "#FFFFFF", textAlign: "center", overflow: "hidden", fontSize: 12, fontWeight: "800", paddingTop: 3 },
  channelText: { fontSize: 12, fontWeight: "800", marginTop: 4 },
  tagLine: { fontSize: 12, color: "#64748B", marginTop: 4 },
  chatHeader: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, backgroundColor: "#FFFFFF", borderBottomColor: "#E2E8F0", borderBottomWidth: 1 },
  messages: { flex: 1, padding: 12 },
  bubble: { maxWidth: "86%", borderRadius: 8, padding: 10, marginBottom: 8 },
  inbound: { backgroundColor: "#FFFFFF", alignSelf: "flex-start", borderColor: "#E2E8F0", borderWidth: 1 },
  outbound: { backgroundColor: "#DCFCE7", alignSelf: "flex-end" },
  messageText: { color: "#0F172A", fontSize: 15 },
  attachmentText: { color: "#2563EB", marginTop: 6, fontWeight: "700" },
  messageMeta: { color: "#64748B", fontSize: 11, marginTop: 6, textAlign: "right" },
  aiCard: { marginHorizontal: 12, marginBottom: 8, padding: 10, borderRadius: 8, backgroundColor: "#EFF6FF", borderColor: "#BFDBFE", borderWidth: 1 },
  aiTitle: { color: "#1D4ED8", fontWeight: "800", marginBottom: 4 },
  aiText: { color: "#0F172A", fontSize: 14 },
  actionRow: { flexDirection: "row", gap: 8, marginTop: 8 },
  smallButton: { backgroundColor: "#0F172A", borderRadius: 7, paddingHorizontal: 12, paddingVertical: 8 },
  smallButtonText: { color: "#FFFFFF", fontWeight: "800" },
  smallButtonGhost: { backgroundColor: "#FFFFFF", borderColor: "#CBD5E1", borderWidth: 1, borderRadius: 7, paddingHorizontal: 12, paddingVertical: 8 },
  smallButtonGhostText: { color: "#0F172A", fontWeight: "800" },
  quickReplyRail: { maxHeight: 44, paddingHorizontal: 12, marginBottom: 6 },
  quickReply: { backgroundColor: "#FFFFFF", borderColor: "#CBD5E1", borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, marginRight: 8 },
  quickReplyText: { color: "#0F172A", fontWeight: "700", fontSize: 12 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 8, padding: 10, backgroundColor: "#FFFFFF", borderTopColor: "#E2E8F0", borderTopWidth: 1 },
  composerInput: { flex: 1, minHeight: 42, maxHeight: 120, borderRadius: 8, backgroundColor: "#F8FAFC", borderColor: "#CBD5E1", borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 },
  sendButton: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center", backgroundColor: "#0F172A" },
  infoRow: { backgroundColor: "#FFFFFF", borderBottomColor: "#E2E8F0", borderBottomWidth: 1, paddingVertical: 12, paddingHorizontal: 12 },
  infoLabel: { color: "#64748B", fontSize: 12, marginBottom: 4 },
  infoValue: { color: "#0F172A", fontSize: 15, fontWeight: "700" },
  tagWrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  tagChip: { backgroundColor: "#E2E8F0", color: "#334155", paddingHorizontal: 10, paddingVertical: 7, borderRadius: 16, overflow: "hidden" },
  noteInput: { minHeight: 120, backgroundColor: "#FFFFFF", borderColor: "#CBD5E1", borderWidth: 1, borderRadius: 8, padding: 10, textAlignVertical: "top" },
  card: { backgroundColor: "#FFFFFF", borderRadius: 8, padding: 12, borderColor: "#E2E8F0", borderWidth: 1, gap: 8, marginBottom: 12 },
  cardTitle: { fontSize: 16, fontWeight: "800", color: "#0F172A" },
  taskRow: { flexDirection: "row", gap: 10, padding: 12, backgroundColor: "#FFFFFF", borderRadius: 8, borderColor: "#E2E8F0", borderWidth: 1, marginBottom: 8 },
  taskTitle: { color: "#0F172A", fontWeight: "800", fontSize: 14 },
  done: { textDecorationLine: "line-through", color: "#94A3B8" },
  metaText: { color: "#64748B", fontSize: 12 },
  profileCard: { alignItems: "center", backgroundColor: "#FFFFFF", borderRadius: 8, padding: 18, borderColor: "#E2E8F0", borderWidth: 1, marginBottom: 12 },
  profileName: { fontSize: 18, fontWeight: "800", color: "#0F172A", marginTop: 10 },
  profileItem: { flexDirection: "row", alignItems: "center", gap: 10, padding: 14, backgroundColor: "#FFFFFF", borderBottomColor: "#E2E8F0", borderBottomWidth: 1 },
  profileItemText: { flex: 1, color: "#0F172A", fontWeight: "700" },
  logoutButton: { marginTop: 18, backgroundColor: "#FEE2E2", borderRadius: 8, minHeight: 48, alignItems: "center", justifyContent: "center" },
  logoutText: { color: "#B91C1C", fontWeight: "800" },
  bottomNav: { flexDirection: "row", backgroundColor: "#FFFFFF", borderTopColor: "#E2E8F0", borderTopWidth: 1, minHeight: 64 },
  navItem: { flex: 1, alignItems: "center", justifyContent: "center", gap: 3 },
  navText: { fontSize: 11, color: "#94A3B8", fontWeight: "700" },
  navTextActive: { color: "#0F172A" },
});
