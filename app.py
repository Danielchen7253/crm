import hashlib
import hmac
import os
import threading
import time
from datetime import datetime, timezone

import requests
from flask import Flask, Response, abort, jsonify, render_template_string, request

app = Flask(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
META_VERIFY_TOKEN = os.getenv("META_VERIFY_TOKEN", "")
META_APP_SECRET = os.getenv("META_APP_SECRET", "")
META_PAGE_ACCESS_TOKEN = os.getenv("META_PAGE_ACCESS_TOKEN", "")
META_PAGE_ID = os.getenv("META_PAGE_ID", "")
GRAPH_API_VERSION = os.getenv("GRAPH_API_VERSION", "v21.0")
AUTO_SYNC_SECONDS = float(os.getenv("CRM_AUTO_SYNC_SECONDS", "2"))
AUTO_SYNC_ENABLED = os.getenv("CRM_AUTO_SYNC_ENABLED", "true").lower() != "false"
AUTO_SYNC_STATE = {"started": False, "last_ok": None, "last_error": None, "runs": 0}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def is_database_configured():
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def supabase_headers(prefer=None, range_header=None):
    if not is_database_configured():
        raise RuntimeError("Supabase environment variables are missing.")
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


def supabase_get(table, params=None):
    response = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=supabase_headers(), params=params or {}, timeout=20)
    response.raise_for_status()
    return response.json()


def supabase_get_all(table, params=None, page_size=1000, max_pages=20):
    rows = []
    params = params or {}
    for page in range(max_pages):
        start = page * page_size
        end = start + page_size - 1
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=supabase_headers(range_header=f"{start}-{end}"),
            params=params,
            timeout=20,
        )
        response.raise_for_status()
        chunk = response.json()
        rows.extend(chunk)
        if len(chunk) < page_size:
            break
    return rows


def supabase_post(table, payload, prefer="return=representation"):
    response = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=supabase_headers(prefer), json=payload, timeout=20)
    response.raise_for_status()
    return response.json()


def supabase_patch(table, payload, params):
    response = requests.patch(f"{SUPABASE_URL}/rest/v1/{table}", headers=supabase_headers("return=representation"), params=params, json=payload, timeout=20)
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


def graph_get(path, params=None):
    params = params or {}
    params["access_token"] = META_PAGE_ACCESS_TOKEN
    response = requests.get(f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}", params=params, timeout=30)
    response.raise_for_status()
    return response.json()


def graph_post(path, payload):
    response = requests.post(
        f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}",
        params={"access_token": META_PAGE_ACCESS_TOKEN},
        json=payload,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def get_messenger_profile(psid):
    if not META_PAGE_ACCESS_TOKEN:
        return {}
    try:
        return graph_get(psid, {"fields": "first_name,last_name,name,profile_pic,locale,timezone,gender"})
    except requests.RequestException:
        return {}


def find_identity(provider, provider_user_id):
    rows = supabase_get(
        "customer_identities",
        {"provider": f"eq.{provider}", "provider_user_id": f"eq.{provider_user_id}", "select": "customer_id,display_name,raw_profile", "limit": "1"},
    )
    return rows[0] if rows else None


def find_identity_by_customer(customer_id, provider="messenger"):
    rows = supabase_get(
        "customer_identities",
        {"customer_id": f"eq.{customer_id}", "provider": f"eq.{provider}", "select": "provider_user_id,display_name,raw_profile", "limit": "1"},
    )
    return rows[0] if rows else None


def build_display_name(profile, fallback):
    if profile.get("name"):
        return profile["name"]
    full_name = " ".join(part for part in [profile.get("first_name", ""), profile.get("last_name", "")] if part).strip()
    return full_name or fallback


def profile_payload(profile, display_name=None):
    payload = {"updated_at": now_iso()}
    if display_name:
        payload["display_name"] = display_name
    if profile.get("profile_pic"):
        payload["profile_pic_url"] = profile["profile_pic"]
    if profile.get("locale"):
        payload["locale"] = profile["locale"]
    if profile.get("timezone") is not None:
        payload["timezone"] = str(profile["timezone"])
    if profile.get("gender"):
        payload["gender"] = profile["gender"]
    return payload


def ensure_customer_from_messenger(psid, known_profile=None, touch=True):
    profile = known_profile or get_messenger_profile(psid)
    if known_profile and not known_profile.get("profile_pic"):
        fetched = get_messenger_profile(psid)
        profile = {**known_profile, **fetched}
    display_name = build_display_name(profile, f"Messenger {psid[-6:]}")
    identity = find_identity("messenger", psid)
    if identity:
        payload = profile_payload(profile, display_name)
        if touch:
            payload["last_seen_at"] = now_iso()
        supabase_patch("customers", payload, {"id": f"eq.{identity['customer_id']}"})
        supabase_patch(
            "customer_identities",
            {"display_name": display_name, "raw_profile": profile, "updated_at": now_iso()},
            {"provider": "eq.messenger", "provider_user_id": f"eq.{psid}"},
        )
        return identity["customer_id"]
    customer = supabase_post(
        "customers",
        {
            "display_name": display_name,
            "source": "messenger",
            "first_seen_at": now_iso(),
            "last_seen_at": now_iso(),
            "profile_pic_url": profile.get("profile_pic"),
            "locale": profile.get("locale"),
            "timezone": str(profile.get("timezone")) if profile.get("timezone") is not None else None,
            "gender": profile.get("gender"),
            "metadata": {"messenger_psid": psid},
        },
    )[0]
    supabase_post(
        "customer_identities",
        {"customer_id": customer["id"], "provider": "messenger", "provider_user_id": psid, "display_name": display_name, "raw_profile": profile},
    )
    return customer["id"]


def save_message(customer_id, provider_message_id, direction, text, attachments, raw_event, sent_at=None):
    if provider_message_id:
        existing = supabase_get("messages", {"provider": "eq.messenger", "provider_message_id": f"eq.{provider_message_id}", "select": "id", "limit": "1"})
        if existing:
            return False
    sent_at = sent_at or now_iso()
    supabase_post(
        "messages",
        {
            "customer_id": customer_id,
            "provider": "messenger",
            "provider_message_id": provider_message_id,
            "direction": direction,
            "message_type": "attachment" if attachments else "text",
            "text": text,
            "attachments": attachments or [],
            "raw_event": raw_event,
            "sent_at": sent_at,
        },
    )
    supabase_patch("customers", {"last_seen_at": now_iso(), "last_message_at": sent_at, "updated_at": now_iso()}, {"id": f"eq.{customer_id}"})
    return True


def process_messenger_event(event):
    message = event.get("message") or {}
    if message.get("is_echo"):
        direction = "outbound"
        customer_psid = event.get("recipient", {}).get("id")
    else:
        direction = "inbound"
        customer_psid = event.get("sender", {}).get("id")
    if not customer_psid:
        return
    customer_id = ensure_customer_from_messenger(customer_psid)
    timestamp = event.get("timestamp")
    sent_at = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat() if timestamp else None
    save_message(customer_id, message.get("mid"), direction, message.get("text"), message.get("attachments", []), event, sent_at)


def sync_messenger_conversations():
    if not META_PAGE_ID or not META_PAGE_ACCESS_TOKEN:
        raise RuntimeError("META_PAGE_ID and META_PAGE_ACCESS_TOKEN are required.")
    imported = 0
    conversations = graph_get(
        f"{META_PAGE_ID}/conversations",
        {"fields": "participants{id,name},messages.limit(10){id,message,from,to,created_time,attachments}", "limit": "100"},
    )
    for conversation in conversations.get("data", []):
        participants = conversation.get("participants", {}).get("data", [])
        customer_participants = [p for p in participants if p.get("id") != META_PAGE_ID]
        if not customer_participants:
            continue
        participant = customer_participants[0]
        psid = participant["id"]
        customer_id = ensure_customer_from_messenger(psid, {"name": participant.get("name")}, touch=False)
        for message in conversation.get("messages", {}).get("data", []):
            from_id = message.get("from", {}).get("id")
            direction = "outbound" if from_id == META_PAGE_ID else "inbound"
            if save_message(customer_id, message.get("id"), direction, message.get("message"), message.get("attachments", {}).get("data", []), message, message.get("created_time")):
                imported += 1
    return imported


def load_dashboard_data(selected_customer_id):
    customers = supabase_get_all(
        "customers",
        {"select": "id,display_name,source,first_seen_at,last_seen_at,last_message_at,profile_pic_url,tags,locale,timezone,gender,metadata", "order": "last_seen_at.desc"},
    )
    if customers and not selected_customer_id:
        selected_customer_id = customers[0]["id"]
    messages = supabase_get("messages", {"select": "customer_id,direction,text,sent_at", "order": "sent_at.desc", "limit": "5000"})
    latest_by_customer = {}
    for message in messages:
        latest_by_customer.setdefault(message["customer_id"], message)
    selected_customer = None
    selected_messages = []
    if selected_customer_id:
        selected_customer = next((customer for customer in customers if customer["id"] == selected_customer_id), None)
        if selected_customer:
            selected_messages = supabase_get(
                "messages",
                {"customer_id": f"eq.{selected_customer_id}", "select": "direction,text,message_type,attachments,sent_at", "order": "sent_at.asc", "limit": "200"},
            )
    return customers, latest_by_customer, selected_customer, selected_messages, selected_customer_id


def redirect_to_customer(customer_id):
    return Response("", status=303, headers={"Location": f"/?customer={customer_id}"})


def auto_sync_loop():
    while True:
        try:
            if is_database_configured() and META_PAGE_ID and META_PAGE_ACCESS_TOKEN:
                sync_messenger_conversations()
                AUTO_SYNC_STATE["last_ok"] = now_iso()
                AUTO_SYNC_STATE["last_error"] = None
                AUTO_SYNC_STATE["runs"] += 1
        except Exception as error:
            AUTO_SYNC_STATE["last_error"] = str(error)
        time.sleep(max(AUTO_SYNC_SECONDS, 1))


def start_auto_sync_worker():
    if AUTO_SYNC_STATE["started"] or not AUTO_SYNC_ENABLED:
        return
    AUTO_SYNC_STATE["started"] = True
    thread = threading.Thread(target=auto_sync_loop, name="messenger-auto-sync", daemon=True)
    thread.start()


@app.get("/")
def dashboard():
    if not is_database_configured():
        return render_template_string(SETUP_TEMPLATE)
    customers, latest_by_customer, selected_customer, selected_messages, selected_customer_id = load_dashboard_data(request.args.get("customer"))
    return render_template_string(
        DASHBOARD_TEMPLATE,
        customers=customers,
        latest_by_customer=latest_by_customer,
        selected_customer=selected_customer,
        selected_messages=selected_messages,
        selected_customer_id=selected_customer_id,
    )


@app.get("/health")
def health():
    return jsonify({"ok": True, "database_configured": is_database_configured(), "auto_sync": AUTO_SYNC_STATE})


@app.get("/webhooks/meta")
def verify_webhook():
    if request.args.get("hub.mode") == "subscribe" and request.args.get("hub.verify_token") == META_VERIFY_TOKEN:
        return Response(request.args.get("hub.challenge") or "", status=200, mimetype="text/plain")
    abort(403)


@app.post("/webhooks/meta")
def receive_webhook():
    raw_body = request.get_data()
    if not verify_meta_signature(raw_body):
        abort(403)
    payload = request.get_json(force=True, silent=True) or {}
    if payload.get("object") != "page":
        return jsonify({"ignored": True})
    for entry in payload.get("entry", []):
        for event in entry.get("messaging", []):
            process_messenger_event(event)
    return jsonify({"ok": True})


@app.post("/customers/<customer_id>/messages")
def send_customer_message(customer_id):
    text = request.form.get("text", "").strip()
    if not text:
        return redirect_to_customer(customer_id)
    identity = find_identity_by_customer(customer_id)
    if not identity:
        return jsonify({"error": "Messenger identity was not found for this customer."}), 404
    result = graph_post("me/messages", {"recipient": {"id": identity["provider_user_id"]}, "messaging_type": "RESPONSE", "message": {"text": text}})
    save_message(customer_id, result.get("message_id"), "outbound", text, [], result, now_iso())
    return redirect_to_customer(customer_id)


@app.post("/admin/import/messenger-conversations")
def import_messenger_conversations():
    try:
        imported = sync_messenger_conversations()
    except RuntimeError as error:
        return jsonify({"error": str(error)}), 400
    return jsonify({"ok": True, "imported_messages": imported})


DASHBOARD_TEMPLATE = """
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CRM 客户工作台</title>
  <style>
    :root { color-scheme: light; font-family: Arial, "Microsoft YaHei", sans-serif; background: #f5f6f8; color: #17202a; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { height: 56px; display: flex; align-items: center; justify-content: space-between; padding: 0 20px; background: #fff; border-bottom: 1px solid #d8dee8; }
    .brand { font-weight: 700; font-size: 16px; }
    .count { color: #5c6773; font-size: 13px; }
    main { display: grid; grid-template-columns: minmax(300px, 380px) minmax(0, 1fr); height: calc(100vh - 57px); min-height: 620px; }
    .list { background: #fff; border-right: 1px solid #d8dee8; overflow: auto; }
    .list-title { position: sticky; top: 0; z-index: 2; background: #fff; padding: 14px 16px; border-bottom: 1px solid #edf0f4; color: #5c6773; font-size: 13px; }
    .customer { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 12px; padding: 14px 16px; border-bottom: 1px solid #edf0f4; text-decoration: none; color: inherit; background: #fff; }
    .customer:hover { background: #f8fafb; }
    .customer.active { background: #eef7f4; border-left: 4px solid #1f8a70; padding-left: 12px; }
    .avatar { width: 44px; height: 44px; border-radius: 50%; background: #1f8a70; color: #fff; display: flex; align-items: center; justify-content: center; font-weight: 700; overflow: hidden; flex: none; }
    .avatar.large { width: 72px; height: 72px; font-size: 24px; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }
    .name { font-weight: 700; margin-bottom: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .preview { color: #3e4b57; font-size: 13px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 5px; }
    .meta { color: #6a7682; font-size: 12px; line-height: 1.35; }
    .workspace { display: flex; flex-direction: column; overflow: hidden; }
    .profile { display: flex; flex-direction: column; min-height: 0; height: 100%; }
    .profile-head { display: flex; align-items: center; gap: 16px; padding: 20px 24px 18px; border-bottom: 1px solid #d8dee8; background: #fff; }
    h1 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; }
    h2 { margin: 18px 0 12px; font-size: 16px; }
    .source { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 9px; border: 1px solid #c7d7d2; border-radius: 999px; background: #eef7f4; color: #17634f; font-size: 12px; font-weight: 700; text-transform: capitalize; }
    .details { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 16px 24px; background: #f5f6f8; }
    .field { background: #fff; border: 1px solid #d8dee8; border-radius: 8px; padding: 12px; min-height: 74px; }
    .label { color: #6a7682; font-size: 12px; margin-bottom: 8px; }
    .value { color: #17202a; font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
    .tags { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 24px 14px; background: #f5f6f8; }
    .tag { border: 1px solid #d8dee8; border-radius: 999px; background: #fff; color: #3e4b57; padding: 5px 10px; font-size: 12px; }
    .conversation { flex: 1; min-height: 0; overflow: auto; padding: 8px 24px 18px; }
    .messages { display: flex; flex-direction: column; gap: 10px; max-width: 820px; }
    .message { max-width: 78%; padding: 10px 12px; border-radius: 8px; border: 1px solid #d8dee8; background: #fff; line-height: 1.45; font-size: 14px; overflow-wrap: anywhere; }
    .message.outbound { align-self: flex-end; background: #eaf2ff; border-color: #c9dcff; }
    .message.inbound { align-self: flex-start; }
    .message-time { color: #6a7682; font-size: 11px; margin-top: 6px; }
    .reply { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 10px; padding: 14px 24px; border-top: 1px solid #d8dee8; background: #fff; }
    textarea { width: 100%; min-height: 44px; max-height: 120px; resize: vertical; border: 1px solid #cfd7e2; border-radius: 8px; padding: 11px 12px; font: inherit; line-height: 1.35; }
    button { border: 0; border-radius: 8px; background: #1f8a70; color: #fff; font-weight: 700; cursor: pointer; }
    button:hover { background: #176f5a; }
    .empty { max-width: 620px; margin: 24px; background: #fff; border: 1px solid #d8dee8; border-radius: 8px; padding: 22px; }
    @media (max-width: 860px) { main { grid-template-columns: 1fr; height: auto; min-height: 0; } .list { border-right: 0; max-height: 42vh; } .workspace { overflow: visible; } .profile { height: auto; } .details { grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 14px; } .profile-head, .conversation, .reply, .tags { padding-left: 14px; padding-right: 14px; } .message { max-width: 92%; } }
    @media (max-width: 520px) { header { padding: 0 14px; } .details { grid-template-columns: 1fr; } .profile-head { align-items: flex-start; } h1 { font-size: 20px; } .reply { grid-template-columns: 1fr; } button { min-height: 42px; } }
  </style>
</head>
<body>
  <header><div class="brand">CRM 客户工作台</div><div class="count">{{ customers|length }} 个客户</div></header>
  <main>
    <section class="list">
      <div class="list-title">按最近互动时间排列，自动同步中</div>
      {% for customer in customers %}
      {% set latest = latest_by_customer.get(customer.id) %}
      <a class="customer {% if customer.id == selected_customer_id %}active{% endif %}" href="/?customer={{ customer.id }}">
        <div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" alt="">{% else %}{{ (customer.display_name or 'C')[:1] }}{% endif %}</div>
        <div><div class="name">{{ customer.display_name or '未命名客户' }}</div><div class="preview">{{ latest.text if latest and latest.text else '暂无文字消息' }}</div><div class="meta">{{ customer.source }} · {{ customer.last_seen_at }}</div></div>
      </a>
      {% else %}
      <div class="customer"><div class="avatar">0</div><div><div class="name">还没有客户</div><div class="preview">客户同步后会自动显示在这里。</div></div></div>
      {% endfor %}
    </section>
    <section class="workspace">
      {% if selected_customer %}
      <div class="profile">
        <div class="profile-head">
          <div class="avatar large">{% if selected_customer.profile_pic_url %}<img src="{{ selected_customer.profile_pic_url }}" alt="">{% else %}{{ (selected_customer.display_name or 'C')[:1] }}{% endif %}</div>
          <div><h1>{{ selected_customer.display_name or '未命名客户' }}</h1><span class="source">{{ selected_customer.source }}</span></div>
        </div>
        <div class="details">
          <div class="field"><div class="label">第一次联系</div><div class="value">{{ selected_customer.first_seen_at or '-' }}</div></div>
          <div class="field"><div class="label">最近互动</div><div class="value">{{ selected_customer.last_seen_at or '-' }}</div></div>
          <div class="field"><div class="label">最近消息时间</div><div class="value">{{ selected_customer.last_message_at or '-' }}</div></div>
          <div class="field"><div class="label">语言 / 时区</div><div class="value">{{ selected_customer.locale or '-' }}{% if selected_customer.timezone %} / {{ selected_customer.timezone }}{% endif %}</div></div>
        </div>
        <div class="tags">{% for tag in selected_customer.tags %}<span class="tag">{{ tag }}</span>{% else %}<span class="tag">暂无标签</span>{% endfor %}</div>
        <div class="conversation"><h2>聊天记录</h2><div class="messages">
          {% for message in selected_messages %}
          <div class="message {{ message.direction }}"><div>{{ message.text if message.text else '[附件或系统消息]' }}</div><div class="message-time">{{ '客户发来' if message.direction == 'inbound' else '我们回复' }} · {{ message.sent_at }}</div></div>
          {% else %}
          <div class="empty">这个客户还没有可显示的聊天记录。</div>
          {% endfor %}
        </div></div>
        <form class="reply" method="post" action="/customers/{{ selected_customer.id }}/messages">
          <textarea name="text" placeholder="输入要发给客户的消息" required></textarea>
          <button type="submit">发送</button>
        </form>
      </div>
      {% else %}
      <div class="empty"><h2>请选择客户</h2><p>左侧客户会按最近互动时间自动排序。点击客户后，这里会显示客户档案和聊天记录。</p></div>
      {% endif %}
    </section>
  </main>
</body>
</html>
"""

SETUP_TEMPLATE = """
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRM Setup</title><style>:root{font-family:Arial,sans-serif;background:#f6f7f9;color:#17202a}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{max-width:720px;width:100%;background:white;border:1px solid #d8dee8;border-radius:8px;padding:28px}code{background:#eef2f7;padding:2px 5px;border-radius:4px}li{margin:8px 0}</style></head><body><main><h1>CRM is online</h1><p>The app is deployed. Finish database and Meta configuration in Render.</p><ol><li>Run <code>schema.sql</code> in Supabase.</li><li>Add Supabase and Messenger environment variables in Render.</li><li>Use <code>/webhooks/meta</code> as the Meta callback path.</li></ol><p>Health check: <code>/health</code></p></main></body></html>
"""

start_auto_sync_worker()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
