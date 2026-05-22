import hashlib
import hmac
import os
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests
from flask import Flask, Response, abort, jsonify, redirect, render_template_string, request

app = Flask(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
META_VERIFY_TOKEN = os.getenv("META_VERIFY_TOKEN", "")
META_APP_SECRET = os.getenv("META_APP_SECRET", "")
META_PAGE_ACCESS_TOKEN = os.getenv("META_PAGE_ACCESS_TOKEN", "")
META_PAGE_ID = os.getenv("META_PAGE_ID", "")
GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def database_ready():
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def sb_headers(prefer=None, range_header=None):
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    if range_header:
        headers["Range-Unit"] = "items"
        headers["Range"] = range_header
    return headers


def sb_get(table, params=None, range_header=None):
    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=sb_headers(range_header=range_header),
        params=params or {},
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def sb_get_all(table, params=None, page_size=1000, max_rows=50000):
    rows = []
    start = 0
    while start < max_rows:
        end = start + page_size - 1
        page = sb_get(table, params, range_header=f"{start}-{end}")
        rows.extend(page)
        if len(page) < page_size:
            break
        start += page_size
    return rows


def sb_post(table, payload):
    response = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=sb_headers("return=representation"),
        json=payload,
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def sb_patch(table, payload, params):
    response = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=sb_headers("return=representation"),
        params=params,
        json=payload,
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def graph_get(path, params=None):
    params = params or {}
    params["access_token"] = META_PAGE_ACCESS_TOKEN
    response = requests.get(
        f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}",
        params=params,
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def graph_post(path, payload):
    response = requests.post(
        f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}",
        params={"access_token": META_PAGE_ACCESS_TOKEN},
        json=payload,
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def verify_meta_signature(raw_body):
    if not META_APP_SECRET:
        return True
    signature = request.headers.get("X-Hub-Signature-256", "")
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(META_APP_SECRET.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, f"sha256={expected}")


def get_profile(psid):
    if not META_PAGE_ACCESS_TOKEN:
        return {}
    try:
        return graph_get(psid, {"fields": "first_name,last_name,name,profile_pic,locale,timezone,gender"})
    except requests.RequestException:
        return {}


def display_name(profile, fallback):
    name = profile.get("name") or " ".join(
        part for part in [profile.get("first_name", ""), profile.get("last_name", "")] if part
    ).strip()
    return name or fallback


def find_identity(psid):
    rows = sb_get(
        "customer_identities",
        {"provider": "eq.messenger", "provider_user_id": f"eq.{psid}", "select": "customer_id", "limit": "1"},
    )
    return rows[0] if rows else None


def find_identity_by_customer(customer_id):
    rows = sb_get(
        "customer_identities",
        {"customer_id": f"eq.{customer_id}", "provider": "eq.messenger", "select": "provider_user_id", "limit": "1"},
    )
    return rows[0] if rows else None


def complete_profile(psid, known_profile=None):
    known_profile = known_profile or {}
    fetched_profile = get_profile(psid)
    return {**known_profile, **fetched_profile}


def ensure_customer(psid, profile=None):
    profile = complete_profile(psid, profile)
    name = display_name(profile, f"Messenger {psid[-6:]}")
    identity = find_identity(psid)
    profile_payload = {"display_name": name, "updated_at": now_iso()}
    if profile.get("profile_pic"):
        profile_payload["profile_pic_url"] = profile["profile_pic"]
    if profile.get("locale"):
        profile_payload["locale"] = profile["locale"]
    if profile.get("timezone") is not None:
        profile_payload["timezone"] = str(profile["timezone"])
    if profile.get("gender"):
        profile_payload["gender"] = profile["gender"]

    if identity:
        customer_id = identity["customer_id"]
        sb_patch("customers", {**profile_payload, "last_seen_at": now_iso()}, {"id": f"eq.{customer_id}"})
        sb_patch(
            "customer_identities",
            {"display_name": name, "raw_profile": profile, "updated_at": now_iso()},
            {"provider": "eq.messenger", "provider_user_id": f"eq.{psid}"},
        )
        return customer_id

    customer = sb_post(
        "customers",
        {
            **profile_payload,
            "source": "messenger",
            "first_seen_at": now_iso(),
            "last_seen_at": now_iso(),
            "metadata": {"messenger_psid": psid},
        },
    )[0]
    sb_post(
        "customer_identities",
        {
            "customer_id": customer["id"],
            "provider": "messenger",
            "provider_user_id": psid,
            "display_name": name,
            "raw_profile": profile,
        },
    )
    return customer["id"]


def save_message(customer_id, message_id, direction, text, attachments, raw, sent_at=None):
    if message_id:
        existing = sb_get(
            "messages",
            {"provider": "eq.messenger", "provider_message_id": f"eq.{message_id}", "select": "id", "limit": "1"},
        )
        if existing:
            return False
    sent_at = sent_at or now_iso()
    sb_post(
        "messages",
        {
            "customer_id": customer_id,
            "provider": "messenger",
            "provider_message_id": message_id,
            "direction": direction,
            "message_type": "attachment" if attachments else "text",
            "text": text,
            "attachments": attachments or [],
            "raw_event": raw,
            "sent_at": sent_at,
        },
    )
    sb_patch(
        "customers",
        {"last_seen_at": now_iso(), "last_message_at": sent_at, "updated_at": now_iso()},
        {"id": f"eq.{customer_id}"},
    )
    return True


def process_event(event):
    message = event.get("message") or {}
    direction = "outbound" if message.get("is_echo") else "inbound"
    psid = event.get("recipient", {}).get("id") if direction == "outbound" else event.get("sender", {}).get("id")
    if not psid:
        return
    timestamp = event.get("timestamp")
    sent_at = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat() if timestamp else None
    customer_id = ensure_customer(psid)
    save_message(customer_id, message.get("mid"), direction, message.get("text"), message.get("attachments", []), event, sent_at)


def collect_attachment_urls(value):
    urls = []
    if isinstance(value, dict):
        for key, child in value.items():
            if key in {"url", "preview_url", "src"} and isinstance(child, str) and child.startswith("http"):
                urls.append(child)
            else:
                urls.extend(collect_attachment_urls(child))
    elif isinstance(value, list):
        for item in value:
            urls.extend(collect_attachment_urls(item))
    return list(dict.fromkeys(urls))


def decorate_message(message):
    attachments = message.get("attachments") or []
    message["attachment_urls"] = collect_attachment_urls(attachments)
    return message


def load_dashboard(selected_id):
    customers = sb_get_all(
        "customers",
        {
            "select": "id,display_name,source,first_seen_at,last_seen_at,last_message_at,profile_pic_url,tags,locale,timezone,gender,metadata",
            "order": "last_seen_at.desc",
        },
    )
    if customers and not selected_id:
        selected_id = customers[0]["id"]

    recent_messages = sb_get(
        "messages",
        {"select": "customer_id,direction,text,sent_at", "order": "sent_at.desc", "limit": "10000"},
    )
    latest = {}
    for message in recent_messages:
        latest.setdefault(message["customer_id"], message)

    selected = next((customer for customer in customers if customer["id"] == selected_id), None) if selected_id else None
    messages = []
    if selected:
        newest_messages = sb_get(
            "messages",
            {
                "customer_id": f"eq.{selected_id}",
                "select": "direction,text,message_type,attachments,sent_at",
                "order": "sent_at.desc",
                "limit": "500",
            },
        )
        messages = [decorate_message(message) for message in reversed(newest_messages)]
    return customers, latest, selected, messages, selected_id


@app.get("/")
def dashboard():
    if not database_ready():
        return "CRM is online, but database is not configured yet."
    customers, latest, selected, messages, selected_id = load_dashboard(request.args.get("customer"))
    return render_template_string(
        TEMPLATE,
        customers=customers,
        latest_by_customer=latest,
        selected_customer=selected,
        selected_messages=messages,
        selected_customer_id=selected_id,
    )


@app.get("/health")
def health():
    return jsonify({"ok": True, "database_configured": database_ready()})


@app.get("/webhooks/meta")
def verify_webhook():
    if request.args.get("hub.mode") == "subscribe" and request.args.get("hub.verify_token") == META_VERIFY_TOKEN:
        return Response(request.args.get("hub.challenge") or "", status=200, mimetype="text/plain")
    abort(403)


@app.post("/webhooks/meta")
def receive_webhook():
    raw = request.get_data()
    if not verify_meta_signature(raw):
        abort(403)
    payload = request.get_json(force=True, silent=True) or {}
    if payload.get("object") == "page":
        for entry in payload.get("entry", []):
            for event in entry.get("messaging", []):
                process_event(event)
    return jsonify({"ok": True})


@app.post("/customers/<customer_id>/messages")
def send_customer_message(customer_id):
    text = request.form.get("text", "").strip()
    identity = find_identity_by_customer(customer_id)
    if text and identity:
        result = graph_post(
            "me/messages",
            {"recipient": {"id": identity["provider_user_id"]}, "messaging_type": "RESPONSE", "message": {"text": text}},
        )
        save_message(customer_id, result.get("message_id"), "outbound", text, [], result, now_iso())
    return redirect(f"/?customer={customer_id}", code=303)


@app.post("/admin/import/messenger-conversations")
def import_messenger_conversations():
    conversations = graph_get(
        f"{META_PAGE_ID}/conversations",
        {"fields": "participants{id,name},messages.limit(10){id,message,from,to,created_time,attachments}", "limit": "100"},
    )
    imported = 0
    for conversation in conversations.get("data", []):
        people = [p for p in conversation.get("participants", {}).get("data", []) if p.get("id") != META_PAGE_ID]
        if not people:
            continue
        customer_id = ensure_customer(people[0]["id"], {"name": people[0].get("name")})
        for message in conversation.get("messages", {}).get("data", []):
            direction = "outbound" if message.get("from", {}).get("id") == META_PAGE_ID else "inbound"
            if save_message(
                customer_id,
                message.get("id"),
                direction,
                message.get("message"),
                message.get("attachments", {}).get("data", []),
                message,
                message.get("created_time"),
            ):
                imported += 1
    return jsonify({"ok": True, "imported_messages": imported})


TEMPLATE = """
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CRM 客户工作台</title>
  <style>
    :root { font-family: Arial, "Microsoft YaHei", sans-serif; color: #17202a; background: #f4f6f8; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .app { display: grid; grid-template-columns: 220px minmax(0, 1fr); height: 100vh; min-height: 640px; }
    .sidebar { background: #fff; border-right: 1px solid #d8dee8; overflow: auto; }
    .sidebar-head { position: sticky; top: 0; z-index: 2; background: #fff; height: 56px; display: flex; align-items: center; padding: 0 16px; border-bottom: 1px solid #edf0f4; font-weight: 700; }
    .customer { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 10px; align-items: center; min-height: 64px; padding: 10px 14px; border-bottom: 1px solid #edf0f4; text-decoration: none; color: inherit; }
    .customer:hover { background: #f8fafb; }
    .customer.active { background: #eef7f4; border-left: 4px solid #1f8a70; padding-left: 10px; }
    .avatar { width: 42px; height: 42px; border-radius: 50%; background: #1f8a70; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; overflow: hidden; flex: none; }
    .avatar.large { width: 72px; height: 72px; font-size: 24px; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }
    .customer-name { font-size: 14px; font-weight: 700; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .work { display: flex; flex-direction: column; min-width: 0; height: 100vh; overflow: hidden; }
    .profile { background: #fff; border-bottom: 1px solid #d8dee8; padding: 18px 24px 16px; }
    .profile-main { display: flex; align-items: center; gap: 16px; }
    .profile h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .pill { border: 1px solid #d8dee8; background: #f8fafb; border-radius: 999px; padding: 5px 10px; font-size: 12px; color: #3e4b57; }
    .tag { background: #eef7f4; border-color: #c7d7d2; color: #17634f; font-weight: 700; }
    .chat { flex: 1; overflow: auto; padding: 18px 24px; }
    .messages { display: flex; flex-direction: column; gap: 10px; max-width: 860px; }
    .message { max-width: 78%; padding: 11px 13px; border: 1px solid #d8dee8; border-radius: 8px; background: #fff; line-height: 1.45; font-size: 14px; overflow-wrap: anywhere; }
    .message.outbound { align-self: flex-end; background: #eaf2ff; border-color: #c9dcff; }
    .message.inbound { align-self: flex-start; }
    .message-text { white-space: pre-wrap; }
    .attachment-list { display: grid; gap: 8px; margin-top: 8px; }
    .attachment-image { display: block; max-width: min(360px, 100%); max-height: 420px; border-radius: 8px; border: 1px solid #d8dee8; object-fit: contain; background: #f8fafb; }
    .attachment-link { color: #17634f; font-size: 13px; word-break: break-all; }
    .time { color: #6a7682; font-size: 11px; margin-top: 6px; }
    .reply { display: grid; grid-template-columns: minmax(0, 1fr) 108px; gap: 12px; align-items: stretch; background: #fff; border-top: 1px solid #d8dee8; padding: 16px 24px; }
    textarea { width: 100%; min-height: 78px; max-height: 180px; resize: vertical; border: 1px solid #cfd7e2; border-radius: 8px; padding: 12px 13px; font: inherit; line-height: 1.4; }
    button { border: 0; border-radius: 8px; background: #1f8a70; color: white; font-weight: 700; cursor: pointer; font-size: 15px; }
    button:hover { background: #176f5a; }
    .empty { margin: 24px; background: #fff; border: 1px solid #d8dee8; border-radius: 8px; padding: 22px; }
    @media (max-width: 860px) {
      .app { grid-template-columns: 112px minmax(0, 1fr); }
      .sidebar-head { padding: 0 10px; font-size: 13px; }
      .customer { grid-template-columns: 42px; justify-items: center; padding: 10px; }
      .customer-name { font-size: 11px; text-align: center; white-space: normal; max-height: 2.5em; }
      .profile { padding: 14px; }
      .chat { padding: 14px; }
      .reply { grid-template-columns: 1fr; padding: 12px 14px; }
      button { min-height: 44px; }
    }
  </style>
</head>
<body>
  <main class="app">
    <aside class="sidebar">
      <div class="sidebar-head">客户 {{ customers|length }}</div>
      {% for customer in customers %}
      <a class="customer {% if customer.id == selected_customer_id %}active{% endif %}" href="/?customer={{ customer.id }}" title="{{ customer.display_name or '未命名客户' }}">
        <div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" alt="">{% else %}{{ (customer.display_name or 'C')[:1] }}{% endif %}</div>
        <div class="customer-name">{{ customer.display_name or '未命名客户' }}</div>
      </a>
      {% else %}
      <div class="empty">还没有客户</div>
      {% endfor %}
    </aside>
    <section class="work">
      {% if selected_customer %}
      <header class="profile">
        <div class="profile-main">
          <div class="avatar large">{% if selected_customer.profile_pic_url %}<img src="{{ selected_customer.profile_pic_url }}" alt="">{% else %}{{ (selected_customer.display_name or 'C')[:1] }}{% endif %}</div>
          <div>
            <h1>{{ selected_customer.display_name or '未命名客户' }}</h1>
            <div class="pill-row">
              <span class="pill tag">{{ selected_customer.source }}</span>
              <span class="pill">第一次联系 {{ selected_customer.first_seen_at or '-' }}</span>
              <span class="pill">最近互动 {{ selected_customer.last_seen_at or '-' }}</span>
              <span class="pill">最后消息 {{ selected_customer.last_message_at or '-' }}</span>
              <span class="pill">语言 {{ selected_customer.locale or '-' }}</span>
              {% for tag in selected_customer.tags %}<span class="pill tag">{{ tag }}</span>{% endfor %}
            </div>
          </div>
        </div>
      </header>
      <section class="chat" id="chat-panel">
        <div class="messages">
          {% for message in selected_messages %}
          <div class="message {{ message.direction }}">
            {% if message.text %}<div class="message-text">{{ message.text }}</div>{% endif %}
            {% if message.attachment_urls %}
            <div class="attachment-list">
              {% for url in message.attachment_urls %}
              <a href="{{ url }}" target="_blank" rel="noopener">
                <img class="attachment-image" src="{{ url }}" alt="客户发送的图片" loading="lazy" onerror="this.style.display='none'; this.parentElement.querySelector('.attachment-link').style.display='inline';">
                <span class="attachment-link" style="display:none;">打开附件</span>
              </a>
              {% endfor %}
            </div>
            {% endif %}
            {% if not message.text and not message.attachment_urls %}<div>[附件或系统消息]</div>{% endif %}
            <div class="time">{{ '客户发来' if message.direction == 'inbound' else '我们回复' }} · {{ message.sent_at }}</div>
          </div>
          {% else %}
          <div class="empty">这个客户还没有可显示的聊天记录。</div>
          {% endfor %}
        </div>
      </section>
      <form class="reply" method="post" action="/customers/{{ selected_customer.id }}/messages">
        <textarea name="text" placeholder="输入要发给客户的消息" required autofocus></textarea>
        <button type="submit">发送</button>
      </form>
      {% else %}
      <div class="empty">请选择客户</div>
      {% endif %}
    </section>
  </main>
  <script>
    (function () {
      const chat = document.getElementById('chat-panel');
      if (!chat) return;
      function scrollToLatest() { chat.scrollTop = chat.scrollHeight; }
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scrollToLatest, { once: true });
      } else {
        scrollToLatest();
      }
      window.addEventListener('load', scrollToLatest, { once: true });
    })();
  </script>
</body>
</html>
"""

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
