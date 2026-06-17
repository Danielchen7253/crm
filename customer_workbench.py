"""Customer-first CRM workbench layout.

This module keeps the existing Messenger/WhatsApp plumbing intact and only
replaces the home screen with a three-zone customer management workspace.
"""

import app_live_new
import crm_api_integrations


app = app_live_new.app
CLOSED_TAG = app_live_new.CLOSED_TAG
crm_module = app_live_new.crm_module


def customer_tags(customer):
    tags = customer.get("tags") or []
    return tags if isinstance(tags, list) else []


def is_closed_customer(customer):
    return CLOSED_TAG in customer_tags(customer)


def filtered_customers(customers, view):
    if view == "closed":
        return [customer for customer in customers if is_closed_customer(customer)]
    if view in {"ai", "settings", "integrations"}:
        return []
    return [customer for customer in customers if not is_closed_customer(customer)]


def view_title(view):
    return {
        "closed": "成交客户",
        "ai": "AI固定话术",
        "integrations": "接口管理",
    }.get(view, "客户池")


def source_label(source):
    return {
        "messenger": "Messenger",
        "private_messenger": "私人 Messenger",
        "whatsapp": "WhatsApp",
        "marketplace": "Marketplace",
        "facebook": "Facebook",
        "shopify": "Shopify",
        "tiktok": "TikTok",
        "website": "网站",
    }.get(source or "", source or "未知来源")


def source_icon(source):
    if source == "whatsapp":
        return "https://upload.wikimedia.org/wikipedia/commons/5/5e/WhatsApp_icon.png"
    if source == "messenger":
        return "https://upload.wikimedia.org/wikipedia/commons/6/63/Facebook_Messenger_logo_2025.svg"
    if source in {"private_messenger", "marketplace", "facebook"}:
        return "https://upload.wikimedia.org/wikipedia/commons/6/63/Facebook_Messenger_logo_2025.svg"
    return ""


def original_channel_url(customer):
    metadata = customer.get("metadata") or {}
    if isinstance(metadata, dict):
        for key in ("profile_url", "conversation_url", "thread_url", "marketplace_item_url", "link", "url"):
            if metadata.get(key):
                return metadata[key]
    source = customer.get("source")
    if source == "messenger":
        return "https://www.messenger.com/"
    if source == "whatsapp":
        return "https://web.whatsapp.com/"
    return ""


def enrich_customers(customers):
    for customer in customers:
        customer["tags"] = customer_tags(customer)
        customer["source_label"] = source_label(customer.get("source"))
        customer["source_icon"] = source_icon(customer.get("source"))
        customer["original_channel_url"] = original_channel_url(customer)


def load_workspace(selected_id):
    view = app_live_new.request.args.get("view", "customers")
    if view in {"unclassified", "today", "quotes"}:
        view = "customers"
    customers = crm_module.sb_get_all(
        "customers",
        {
            "select": "id,display_name,source,first_seen_at,last_seen_at,last_message_at,profile_pic_url,tags,locale,timezone,gender,metadata",
            "order": "last_message_at.desc.nullslast",
        },
        page_size=1000,
        max_rows=5000,
    )
    enrich_customers(customers)
    app_live_new.attach_last_message_preview(customers)
    customer_pool = filtered_customers(customers, view)
    if view in {"ai", "integrations"}:
        selected_id = None
    elif customer_pool and not selected_id:
        selected_id = customer_pool[0]["id"]
    selected = next((customer for customer in customer_pool if customer["id"] == selected_id), None) if selected_id else None
    messages = []
    if selected:
        newest_messages = crm_module.sb_get(
            "messages",
            {
                "customer_id": f"eq.{selected_id}",
                "select": "id,direction,text,message_type,attachments,sent_at",
                "order": "sent_at.desc",
                "limit": "80",
            },
        )
        messages = [crm_module.decorate_message(message) for message in reversed(newest_messages)]
    return customers, customer_pool, selected, messages, selected_id, view


def integration_cards():
    status = crm_api_integrations.api_status_payload()
    cards = [
        {
            "id": "messenger",
            "name": "Messenger",
            "summary": "Page Messenger customers, webhooks, names, avatars, and replies.",
            "block": status.get("messenger") or {"ready": False, "items": []},
        },
        {
            "id": "whatsapp",
            "name": "WhatsApp",
            "summary": "WhatsApp Business Cloud API phone, token, webhook, and message status.",
            "block": status.get("whatsapp") or {"ready": False, "items": []},
        },
        {
            "id": "sms",
            "name": "SMS / 手机短信",
            "summary": "Import customer text messages, phone numbers, follow-up reminders, and SMS conversation links.",
            "block": {
                "ready": False,
                "items": [
                    {"name": "SMS provider", "ok": False, "detail": "Choose a provider first: Twilio, OpenPhone, TextGrid, MessageBird, or another SMS inbox/API."},
                    {"name": "Your phone number", "ok": False, "detail": "6263930488 can be connected only if the provider supports porting, hosted SMS, forwarding, or an approved messaging registration flow."},
                    {"name": "CRM import path", "ok": True, "detail": "Ready to store phone, customer, message, source, and follow-up records after provider setup."},
                ],
            },
        },
        {
            "id": "shopify",
            "name": "Shopify",
            "summary": "Inventory, orders, fulfillment, customer purchase history, and AI lookup.",
            "block": crm_api_integrations.safe_call(
                lambda: {"ready": False, "items": [{"name": "Shopify connector", "ok": False, "detail": "Open /admin/shopify for detailed configuration."}]}
            ),
        },
        {
            "id": "website_chat",
            "name": "网页客服",
            "summary": "Right-bottom chat widget for Shopify, gasket sites, product pages, photo upload, and CRM capture.",
            "block": {
                "ready": True,
                "items": [
                    {"name": "Widget script", "ok": True, "detail": "/chat/widget.js"},
                    {"name": "Demo page", "ok": True, "detail": "/chat/demo"},
                    {"name": "CRM message intake", "ok": True, "detail": "Website visitors are saved into customers and messages with source=website."},
                    {"name": "Private order protection", "ok": True, "detail": "Order, tracking, address, warranty, payment, and refund questions require order number plus email or phone."},
                ],
            },
        },
        {
            "id": "promotion",
            "name": "推广发帖",
            "summary": "Facebook group posting workspace and promotion material queue.",
            "block": {
                "ready": (status.get("promotion") or {}).get("ready"),
                "items": [
                    {
                        "name": "Facebook Page",
                        "ok": (status.get("promotion") or {}).get("ready"),
                        "detail": (status.get("promotion") or {}).get("detail"),
                    },
                    {
                        "name": "Posting workspace",
                        "ok": True,
                        "detail": "Available at /promotion",
                    },
                ],
            },
        },
        {
            "id": "extension",
            "name": "Chrome插件",
            "summary": "Private Messenger, Marketplace, Facebook pages, and one-click customer capture.",
            "block": {
                "ready": False,
                "items": [
                    {"name": "Local extension", "ok": False, "detail": "Planned next: save customer name, avatar, source link, notes, and follow-up reminders."},
                    {"name": "Official API dependency", "ok": True, "detail": "No Meta App Review required for first local helper version."},
                ],
            },
        },
    ]
    return cards


TEMPLATE = """
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CRM 客户工作台</title>
<style>
:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}
*{box-sizing:border-box}body{margin:0}.app{display:grid;grid-template-columns:118px 320px minmax(0,1fr);height:100vh;min-height:640px;overflow:hidden}.nav{background:#16202a;color:#dbe3ec;display:flex;flex-direction:column;gap:8px;padding:14px 10px}.nav-title{color:#fff;font-size:16px;font-weight:900;padding:8px 8px 14px}.nav-link{display:grid;gap:4px;color:inherit;text-decoration:none;border-radius:8px;padding:11px 9px;font-size:13px;line-height:1.2}.nav-link:hover,.nav-link.active{background:#233241;color:#fff}.nav-count{color:#9fb0bf;font-size:11px}.middle{background:#fff;border-right:1px solid #d8dee8;overflow:auto}.middle-head{position:sticky;top:0;z-index:3;background:#fff;border-bottom:1px solid #edf0f4;padding:14px 16px}.middle-title{font-weight:900;font-size:17px}.middle-sub{color:#6a7682;font-size:12px;margin-top:3px}.customer{display:grid;grid-template-columns:46px minmax(0,1fr);gap:11px;align-items:center;min-height:76px;padding:12px 14px;border-bottom:1px solid #edf0f4;text-decoration:none;color:inherit}.customer:hover{background:#f8fafb}.customer.active{background:#eef7f4;border-left:4px solid #1f8a70;padding-left:10px}.avatar{width:46px;height:46px;border-radius:50%;background:#1f8a70;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;overflow:hidden;flex:none}.avatar.large{width:76px;height:76px;font-size:26px}.avatar img{width:100%;height:100%;object-fit:cover}.customer-info{min-width:0;display:grid;gap:6px}.customer-top{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}.customer-name{font-size:14px;font-weight:900;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.last-time{color:#8a96a3;font-size:11px;white-space:nowrap}.customer-bottom{display:grid;grid-template-columns:22px minmax(0,1fr);gap:7px;align-items:center}.source-logo{width:22px;height:22px;border-radius:50%;border:1px solid #d8dee8;background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:10px;font-weight:900;color:#6a7682}.source-logo img{width:100%;height:100%;object-fit:contain}.last-preview{min-width:0;color:#6a7682;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.work{display:flex;flex-direction:column;min-width:0;height:100vh;overflow:hidden}.profile{background:#fff;border-bottom:1px solid #d8dee8;padding:18px 24px}.profile-main{display:flex;align-items:flex-start;gap:16px}.profile h1{font-size:25px;line-height:1.2;margin:0 0 10px}.profile-meta{display:flex;flex-wrap:wrap;gap:8px}.pill{border:1px solid #d8dee8;background:#f8fafb;border-radius:999px;padding:5px 10px;font-size:12px;color:#3e4b57}.tag{background:#eef7f4;border-color:#c7d7d2;color:#17634f;font-weight:800}.profile-actions{margin-left:auto;display:flex;gap:8px;align-items:center}.button,button{border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:800;cursor:pointer;font-size:14px;padding:10px 14px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;min-height:40px}.secondary-button{background:#e8edf3;color:#17202a}.workspace{flex:1;overflow:auto;padding:18px 24px;display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px;align-items:start}.panel{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:16px;display:grid;gap:12px;min-width:0}.panel h2{font-size:16px;margin:0}.muted{color:#6a7682;font-size:13px;line-height:1.45}.action-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.field-list{display:grid;gap:9px}.field{display:grid;grid-template-columns:88px minmax(0,1fr);gap:10px;font-size:13px;border-bottom:1px solid #edf0f4;padding-bottom:8px}.field:last-child{border-bottom:0;padding-bottom:0}.label{color:#6a7682}.value{font-weight:700;min-width:0;overflow-wrap:anywhere}.messages{display:flex;flex-direction:column;gap:10px;max-height:420px;overflow:auto;padding-right:4px}.message{max-width:86%;padding:10px 12px;border:1px solid #d8dee8;border-radius:8px;background:#fff;line-height:1.45;font-size:13px;overflow-wrap:anywhere}.message.outbound{align-self:flex-end;background:#eaf2ff;border-color:#c9dcff}.message.inbound{align-self:flex-start}.message-text{white-space:pre-wrap}.attachment-list{display:grid;gap:8px;margin-top:8px}.attachment-image{display:block;max-width:min(320px,100%);max-height:320px;border-radius:8px;border:1px solid #d8dee8;object-fit:contain;background:#f8fafb}.attachment-audio{width:min(320px,100%);height:42px;display:block}.attachment-file{display:inline-flex;min-height:34px;border:1px solid #c7d7d2;border-radius:8px;color:#17634f;background:#f7fbfa;padding:7px 10px;font-size:13px;text-decoration:none;word-break:break-all}.time{color:#6a7682;font-size:11px;margin-top:6px}.reply{display:grid;gap:10px}.reply-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}.ai-draft{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:#3e4b57;font-size:12px}.ai-badge{border:1px solid #c7d7d2;background:#eef7f4;color:#17634f;border-radius:999px;padding:4px 9px;font-weight:800}textarea,input{width:100%;border:1px solid #cfd7e2;border-radius:8px;padding:10px 12px;font:inherit;line-height:1.4;background:#fff}textarea{min-height:96px;resize:vertical}.rule-row{display:grid;gap:6px;border-bottom:1px solid #edf0f4;padding:12px 0}.rule-title{font-weight:900}.empty{margin:20px;background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:22px}.mobile-back,.mobile-menu{display:none}
@media(max-width:1060px){.app{grid-template-columns:92px 250px minmax(0,1fr)}.workspace{grid-template-columns:1fr}.nav-link{font-size:12px;padding:9px 7px}.profile,.workspace{padding:14px}.avatar.large{width:58px;height:58px}}
@media(max-width:720px){html,body{height:100%;overflow:hidden;background:#fff}.app{display:block;height:100dvh;min-height:0}.nav{display:none}.mobile-menu{display:block;position:fixed;right:10px;top:10px;z-index:80}.mobile-menu summary{list-style:none;width:42px;height:42px;border-radius:12px;background:#16202a;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:900;box-shadow:0 8px 24px rgba(15,23,42,.18)}.mobile-menu summary::-webkit-details-marker{display:none}.mobile-menu-panel{margin-top:8px;min-width:184px;background:#16202a;color:#dbe3ec;border-radius:12px;padding:8px;box-shadow:0 14px 34px rgba(15,23,42,.28);display:grid;gap:6px}.middle{height:100dvh;border-right:0}.middle-head{padding:14px 64px 14px 16px}.customer{grid-template-columns:48px minmax(0,1fr);min-height:74px;padding:12px 16px}.avatar{width:48px;height:48px}.app:not(.mobile-chat-open) .work{display:none}.app.mobile-chat-open .middle{display:none}.app.mobile-chat-open .work{display:flex;height:100dvh;background:#f4f6f8}.profile{position:sticky;top:0;z-index:20;padding:10px 12px}.profile-main{align-items:center;gap:8px}.mobile-back{display:inline-flex;align-items:center;justify-content:center;width:34px;height:44px;color:#17634f;text-decoration:none;font-weight:900;font-size:20px;flex:none}.avatar.large{width:44px;height:44px;font-size:16px}.profile h1{font-size:17px;margin:0 0 6px}.profile-meta{flex-wrap:nowrap;overflow:auto;gap:6px}.pill{white-space:nowrap;font-size:11px;padding:4px 8px}.profile-actions{margin-left:0}.profile-actions button{min-height:34px;padding:0 10px;font-size:12px}.workspace{display:block;flex:1;overflow:auto;padding:12px}.panel{margin-bottom:12px;padding:13px}.action-grid{grid-template-columns:1fr}.field{grid-template-columns:72px minmax(0,1fr)}.messages{max-height:none}.reply-row{grid-template-columns:1fr}.empty{margin:16px}.button,button{width:100%}}
</style>
</head>
<body>
<details class="mobile-menu"><summary aria-label="Menu">&#9776;</summary><div class="mobile-menu-panel">
<a class="nav-link {% if view == 'customers' %}active{% endif %}" href="/?view=customers"><span>客户池</span><span class="nav-count">{{ active_count }}</span></a>
<a class="nav-link {% if view == 'closed' %}active{% endif %}" href="/?view=closed"><span>成交客户</span><span class="nav-count">{{ closed_count }}</span></a>
<a class="nav-link {% if view == 'ai' %}active{% endif %}" href="/?view=ai"><span>AI话术</span><span class="nav-count">{{ fixed_reply_rules|length }}</span></a>
<a class="nav-link {% if view == 'integrations' %}active{% endif %}" href="/?view=integrations"><span>接口管理</span><span class="nav-count">API</span></a>
<a class="nav-link" href="/settings"><span>系统设置</span><span class="nav-count">lock</span></a>
</div></details>
<main class="app {% if mobile_chat_open %}mobile-chat-open{% endif %}">
<aside class="nav">
<div class="nav-title">CRM</div>
<a class="nav-link {% if view == 'customers' %}active{% endif %}" href="/?view=customers"><span>客户池</span><span class="nav-count">{{ active_count }}</span></a>
<a class="nav-link {% if view == 'closed' %}active{% endif %}" href="/?view=closed"><span>成交客户</span><span class="nav-count">{{ closed_count }}</span></a>
<a class="nav-link {% if view == 'ai' %}active{% endif %}" href="/?view=ai"><span>AI话术</span><span class="nav-count">{{ fixed_reply_rules|length }}</span></a>
<a class="nav-link {% if view == 'integrations' %}active{% endif %}" href="/?view=integrations"><span>接口管理</span><span class="nav-count">API</span></a>
<a class="nav-link" href="/settings"><span>系统设置</span><span class="nav-count">lock</span></a>
</aside>
<aside class="middle">
{% if view == 'ai' %}
<div class="middle-head"><div class="middle-title">AI固定话术</div><div class="middle-sub">固定答案集中维护</div></div>
{% for rule in fixed_reply_rules %}
<a class="customer" href="#rule-{{ rule.id or loop.index }}"><div class="source-logo">AI</div><div class="customer-info"><div class="customer-name">{{ rule.title }}</div><div class="last-preview">{{ '启用' if rule.is_active else '停用' }} · {{ rule.category }}</div></div></a>
{% else %}<div class="empty">还没有固定话术</div>{% endfor %}
{% elif view == 'integrations' %}
<div class="middle-head"><div class="middle-title">接口管理</div><div class="middle-sub">所有外部平台集中在这里</div></div>
{% for card in integration_cards %}
<a class="customer" href="#integration-{{ card.id }}">
<div class="source-logo">{{ card.name[:2]|upper }}</div>
<div class="customer-info">
<div class="customer-top"><div class="customer-name">{{ card.name }}</div><div class="last-time">{{ 'OK' if card.block.ready else 'CHECK' }}</div></div>
<div class="customer-bottom"><span class="source-logo">{{ loop.index }}</span><span class="last-preview">{{ card.summary }}</span></div>
</div>
</a>
{% endfor %}
{% else %}
<div class="middle-head"><div class="middle-title">{{ view_title }}</div><div class="middle-sub">{{ customer_pool|length }} / {{ customers|length }} · 按最后互动排序</div></div>
{% for customer in customer_pool %}
<a class="customer {% if customer.id == selected_customer_id %}active{% endif %}" href="/?view={{ view }}&customer={{ customer.id }}" title="{{ customer.display_name or '未命名客户' }}">
<div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" alt="">{% else %}{{ (customer.display_name or 'C')[:1] }}{% endif %}</div>
<div class="customer-info">
<div class="customer-top"><div class="customer-name">{{ customer.display_name or '未命名客户' }}</div><div class="last-time">{{ customer.last_message_time_short }}</div></div>
<div class="customer-bottom"><span class="source-logo">{% if customer.source_icon %}<img src="{{ customer.source_icon }}" alt="{{ customer.source_label }}">{% else %}{{ (customer.source_label or '?')[:2]|upper }}{% endif %}</span><span class="last-preview">{{ customer.last_message_preview or customer.source_label }}</span></div>
</div>
</a>
{% else %}<div class="empty">这个分区暂时没有客户</div>{% endfor %}
{% endif %}
</aside>
<section class="work">
{% if view == 'ai' %}
<header class="profile"><div class="profile-main"><div><h1>AI固定话术</h1><div class="profile-meta"><span class="pill tag">固定答案优先</span><span class="pill">匹配不到再生成草稿</span></div></div></div></header>
<section class="workspace"><div class="panel">
{% for rule in fixed_reply_rules %}
<form class="rule-row" id="rule-{{ rule.id or loop.index }}" method="post" action="/admin/ai/fixed-replies">
<input type="hidden" name="id" value="{{ rule.id or '' }}">
<div class="rule-title">{{ rule.title }}</div>
<input name="title" value="{{ rule.title }}" required>
<input name="category" value="{{ rule.category }}" required>
<textarea name="keywords">{{ rule.keywords|join(', ') }}</textarea>
<textarea name="reply_text" required>{{ rule.reply_text }}</textarea>
<label><input type="checkbox" name="is_active" value="1" {% if rule.is_active %}checked{% endif %}> 启用</label>
<button type="submit">保存</button>
</form>
{% endfor %}
<form class="rule-row" method="post" action="/admin/ai/fixed-replies"><div class="rule-title">新增固定话术</div><input name="title" placeholder="例：发货时间"><input name="category" placeholder="shipping"><textarea name="keywords" placeholder="ship, shipping, 发货"></textarea><textarea name="reply_text" placeholder="固定回复内容"></textarea><label><input type="checkbox" name="is_active" value="1" checked> 启用</label><button type="submit">新增</button></form>
</div></section>
{% elif view == 'integrations' %}
<header class="profile"><div class="profile-main"><div><h1>接口管理</h1><div class="profile-meta"><span class="pill tag">CRM内部页面</span><span class="pill">Messenger / WhatsApp / SMS / Shopify / 插件</span></div></div><div class="profile-actions"><a class="button secondary-button" href="/admin/channels">打开备用诊断页</a></div></div></header>
<section class="workspace">
<div class="panel">
<h2>接口总览</h2>
<div class="muted">这里以后就是所有平台接入的主入口，不再跳到独立后台页。绿色代表已接通，红色代表缺配置或缺权限。</div>
{% for card in integration_cards %}
<div class="rule-row" id="integration-{{ card.id }}">
<div class="customer-top"><div class="rule-title">{{ card.name }}</div><span class="pill {{ 'tag' if card.block.ready else '' }}">{{ '已接通' if card.block.ready else '需要处理' }}</span></div>
<div class="muted">{{ card.summary }}</div>
{% for item in card.block['items'] %}
<div class="field"><div class="label">{{ item.name }}</div><div class="value">{{ 'OK' if item.ok else '问题' }} · {{ item.detail }}</div></div>
{% endfor %}
</div>
{% endfor %}
</div>
<aside class="panel">
<h2>常用操作</h2>
<a class="button" href="/?view=customers">回到客户池</a>
<a class="button secondary-button" href="#integration-sms">短信导入口</a>
<a class="button secondary-button" href="/admin/channels">备用诊断页</a>
<a class="button secondary-button" href="/promotion">群组发帖工作台</a>
<form method="post" action="/admin/import/messenger-conversations/all"><button class="secondary-button" type="submit">同步 Messenger 客户</button></form>
<div class="muted">私人 Messenger / Marketplace 后面走 Chrome 插件，不放在官方 API 状态里硬等审批。</div>
</aside>
</section>
{% elif selected_customer %}
<header class="profile"><div class="profile-main">
<a class="mobile-back" href="/?view={{ view }}" aria-label="Back">&lsaquo;</a>
<div class="avatar large">{% if selected_customer.profile_pic_url %}<img src="{{ selected_customer.profile_pic_url }}" alt="">{% else %}{{ (selected_customer.display_name or 'C')[:1] }}{% endif %}</div>
<div><h1>{{ selected_customer.display_name or '未命名客户' }}</h1><div class="profile-meta"><span class="pill tag">{{ selected_customer.source_label }}</span><span class="pill">首次 {{ selected_customer.first_seen_at or '-' }}</span><span class="pill">最近 {{ selected_customer.last_seen_at or '-' }}</span><span class="pill">最后消息 {{ selected_customer.last_message_at or '-' }}</span>{% for tag in selected_customer.tags %}<span class="pill tag">{{ tag }}</span>{% endfor %}</div></div>
<div class="profile-actions"><form method="post" action="/customers/{{ selected_customer.id }}/tags/closed?view={{ view }}">{% if '成交客户' in selected_customer.tags %}<input type="hidden" name="action" value="remove"><button class="secondary-button" type="submit">移出成交</button>{% else %}<input type="hidden" name="action" value="add"><button type="submit">标记成交</button>{% endif %}</form></div>
</div></header>
<section class="workspace">
<div class="panel">
<h2>客户资料</h2>
<div class="field-list">
<div class="field"><div class="label">姓名</div><div class="value">{{ selected_customer.display_name or '未命名客户' }}</div></div>
<div class="field"><div class="label">来源</div><div class="value">{{ selected_customer.source_label }}</div></div>
<div class="field"><div class="label">语言</div><div class="value">{{ selected_customer.locale or '-' }}</div></div>
<div class="field"><div class="label">时区</div><div class="value">{{ selected_customer.timezone or '-' }}</div></div>
<div class="field"><div class="label">客户ID</div><div class="value">{{ selected_customer.id }}</div></div>
</div>
<div class="action-grid">
{% if selected_customer.original_channel_url %}<a class="button" href="{{ selected_customer.original_channel_url }}" target="_blank" rel="noopener">打开原始渠道</a>{% endif %}
<a class="button secondary-button" href="/?view=integrations">接口管理</a>
</div>
</div>
<div class="panel">
<h2>最近互动</h2>
<div class="messages" id="chat-panel">
{% for message in selected_messages %}
<div class="message {{ message.direction }}">{% if message.text %}<div class="message-text">{{ message.text }}</div>{% endif %}{% if message.image_attachments or message.audio_attachments or message.file_attachments %}<div class="attachment-list">{% for item in message.image_attachments %}<a href="{{ item.url }}" target="_blank" rel="noopener"><img class="attachment-image" src="{{ item.url }}" alt="客户图片" loading="lazy"></a>{% endfor %}{% for item in message.audio_attachments %}<audio class="attachment-audio" controls preload="metadata" src="{{ item.url }}"></audio>{% endfor %}{% for item in message.file_attachments %}<a class="attachment-file" href="{{ item.url }}" target="_blank" rel="noopener">打开附件</a>{% endfor %}</div>{% endif %}<div class="time">{{ '客户' if message.direction == 'inbound' else '我们' }} · {{ message.sent_at }}</div></div>
{% else %}<div class="muted">还没有互动记录。</div>{% endfor %}
</div>
</div>
<aside class="panel">
<h2>操作区</h2>
<div class="muted">客户集中管理，聊天仍可回到原平台；这里负责下一步动作、AI草稿、成交状态。</div>
<form class="reply" method="post" action="/customers/{{ selected_customer.id }}/messages">
{% if ai_draft %}<div class="ai-draft"><span class="ai-badge">AI建议</span><span>{{ ai_draft.category }}</span></div><input type="hidden" name="ai_draft_id" value="{{ ai_draft.id }}">{% else %}<div class="ai-draft"><span class="ai-badge">AI提示</span><span class="muted">收到新消息后这里显示草稿</span></div>{% endif %}
<textarea name="text" placeholder="AI草稿或人工备注，可修改后发送">{{ ai_draft.draft_text if ai_draft else '' }}</textarea>
<div class="reply-row"><div class="muted">发送仍走已接通渠道；私人 Messenger 后面用插件辅助。</div><button type="submit">发送</button></div>
</form>
<textarea placeholder="内部备注：客户需求、报价、下次跟进原因"></textarea>
<div class="action-grid"><button class="secondary-button" type="button">保存备注</button><button class="secondary-button" type="button">设置提醒</button></div>
</aside>
</section>
{% else %}
<div class="empty">请选择一个客户</div>
{% endif %}
</section>
</main>
<script>(function(){const chat=document.getElementById('chat-panel');function s(){if(chat)chat.scrollTop=chat.scrollHeight;}if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',s,{once:true});else s();window.addEventListener('load',s,{once:true});})();</script>
</body>
</html>
"""


def live_dashboard():
    if not crm_module.database_ready():
        return "CRM is online, but database is not configured yet."
    customers, customer_pool, selected, messages, selected_id, view = load_workspace(app_live_new.request.args.get("customer"))
    fixed_reply_rules = app_live_new.load_fixed_reply_rules(active_only=False)
    active_count = len(filtered_customers(customers, "customers"))
    closed_count = len(filtered_customers(customers, "closed"))
    return app_live_new.render_template_string(
        TEMPLATE,
        customers=customers,
        customer_pool=customer_pool,
        selected_customer=selected,
        selected_messages=messages,
        selected_customer_id=selected_id,
        mobile_chat_open=bool(app_live_new.request.args.get("customer")) or view in {"ai", "integrations"},
        ai_draft=crm_module.load_ai_draft(selected, messages),
        view=view,
        view_title=view_title(view),
        fixed_reply_rules=fixed_reply_rules,
        integration_cards=integration_cards(),
        active_count=active_count,
        closed_count=closed_count,
    )


app_live_new.filtered_customers = filtered_customers
app_live_new.load_workspace = load_workspace
app_live_new.TEMPLATE = TEMPLATE
app_live_new.live_dashboard = live_dashboard
app.view_functions["dashboard"] = live_dashboard
