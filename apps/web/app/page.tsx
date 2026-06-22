"use client";

import { Bot, CheckCircle2, Clock3, Filter, Inbox, Mail, MessageCircle, Phone, Search, Send, Settings, Tag, UserRound } from "lucide-react";
import { useMemo, useState } from "react";

const channels = [
  { key: "all", label: "全部", icon: Inbox },
  { key: "unread", label: "未读", icon: Clock3 },
  { key: "messenger", label: "Messenger", icon: MessageCircle },
  { key: "whatsapp", label: "WhatsApp", icon: Phone },
  { key: "sms", label: "SMS", icon: Phone },
  { key: "instagram", label: "Instagram", icon: MessageCircle },
  { key: "email", label: "Email", icon: Mail },
  { key: "website_chat", label: "网站聊天", icon: MessageCircle },
];

const sampleConversations = [
  {
    id: "1",
    channel: "messenger",
    name: "Maria G.",
    avatar: "",
    tag: "空调维修师傅",
    last: "Do you have 45+5 capacitor today?",
    time: "2 min",
    unread: 2,
  },
  {
    id: "2",
    channel: "sms",
    name: "+1 713 555 1190",
    avatar: "",
    tag: "推广获客",
    last: "Can I pick up after 4 PM?",
    time: "18 min",
    unread: 0,
  },
  {
    id: "3",
    channel: "website_chat",
    name: "Website visitor",
    avatar: "",
    tag: "商用冰箱维修客户",
    last: "I need gasket by model number.",
    time: "1 hr",
    unread: 0,
  },
];

const messages = [
  { id: "m1", direction: "inbound", text: "Do you have 45+5 capacitor today?", time: "10:12 AM" },
  { id: "m2", direction: "inbound", text: "I can pick up in Houston.", time: "10:13 AM" },
  {
    id: "m3",
    direction: "system",
    text: "AI suggestion: Yes, 45+5 is in stock. Pickup address is 755 International Blvd, Houston, TX 77024.",
    time: "10:13 AM",
  },
];

export default function Page() {
  const [activeChannel, setActiveChannel] = useState("all");
  const [activeConversation, setActiveConversation] = useState(sampleConversations[0]);
  const visibleConversations = useMemo(
    () => sampleConversations.filter((item) => activeChannel === "all" || activeChannel === "unread" ? activeChannel === "all" || item.unread > 0 : item.channel === activeChannel),
    [activeChannel],
  );

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
              onClick={() => setActiveChannel(item.key)}
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
            <h1>客户池</h1>
            <p>统一 Inbox</p>
          </div>
          <button className="iconButton" title="筛选">
            <Filter size={18} />
          </button>
        </header>
        <label className="search">
          <Search size={16} />
          <input placeholder="搜索客户、电话、邮箱" />
        </label>
        <div className="conversationList">
          {visibleConversations.map((conversation) => (
            <button
              key={conversation.id}
              className={activeConversation.id === conversation.id ? "conversation active" : "conversation"}
              onClick={() => setActiveConversation(conversation)}
            >
              <div className={`avatar ${conversation.channel}`}>{conversation.name.slice(0, 1)}</div>
              <div className="conversationBody">
                <div className="line">
                  <strong>{conversation.name}</strong>
                  <span>{conversation.time}</span>
                </div>
                <div className="line last">
                  <small>{conversation.last}</small>
                  {conversation.unread > 0 && <b>{conversation.unread}</b>}
                </div>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="chatPane">
        <header className="chatHeader">
          <div className={`avatar large ${activeConversation.channel}`}>{activeConversation.name.slice(0, 1)}</div>
          <div>
            <h2>{activeConversation.name}</h2>
            <p>{activeConversation.channel} · 最近互动 {activeConversation.time}</p>
          </div>
        </header>
        <div className="messages">
          {messages.map((message) => (
            <article key={message.id} className={`bubble ${message.direction}`}>
              <p>{message.text}</p>
              <span>{message.time}</span>
            </article>
          ))}
        </div>
        <footer className="composer">
          <div className="aiDraft">
            <Bot size={16} />
            <span>AI 只生成草稿，客服确认后发送。</span>
            <button>插入</button>
          </div>
          <div className="inputRow">
            <textarea placeholder="输入回复，或选择快捷回复 / AI 草稿" />
            <button className="sendButton" title="发送">
              <Send size={20} />
            </button>
          </div>
        </footer>
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
          <label>客户类型</label>
          <div className="tag"><Tag size={14} />{activeConversation.tag}</div>
        </section>
        <section className="detailBlock">
          <label>渠道身份</label>
          <div className="identity"><CheckCircle2 size={16} />{activeConversation.channel}</div>
          <div className="identity"><Phone size={16} />phone/email 自动合并</div>
        </section>
        <section className="detailBlock">
          <label>内部备注</label>
          <textarea placeholder="记录跟进事项、报价、客户偏好" />
        </section>
      </aside>
    </main>
  );
}
