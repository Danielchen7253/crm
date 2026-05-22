import hashlib
import hmac
import os
from datetime import datetime, timezone

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
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=sb_headers(range_header=range_header), params=params or {}, timeout=20)
    r.raise_for_status()
    return r.json()


def sb_post(table, payload):
    r = requests.post(f"{SUPABASE_URL}/rest/v1/{table}", headers=sb_headers("return=representation"), json=payload, timeout=20)
    r.raise_for_status()
    return r.json()


def sb_patch(table, payload, params):
    r = requests.patch(f"{SUPABASE_URL}/rest/v1/{table}", headers=sb_headers("return=representation"), params=params, json=payload, timeout=20)
    r.raise_for_status()
    return r.json()


def graph_get(path, params=None):
    params = params or {}
    params["access_token"] = META_PAGE_ACCESS_TOKEN
    r = requests.get(f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}", params=params, timeout=20)
    r.raise_for_status()
    return r.json()


def graph_post(path, payload):
    r = requests.post(f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}", params={"access_token": META_PAGE_ACCESS_TOKEN}, json=payload, timeout=20)
    r.raise_for_status()
    return r.json()


def verify_meta_signature(raw_body):
    if not META_APP_SECRET:
        return True
    signature = request.headers.get("X-Hub-Signature-256", "")
    if not signature.startswith("sha256="):
        return False
    expected = hmac.new(META_APP_SECRET.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(signature, f"sha256={expected}")


def get_profile(psid):
    try:
        return graph_get(psid, {"fields": "first_name,last_name,name,profile_pic,locale,timezone,gender"})
    except requests.RequestException:
        return {}


def display_name(profile, fallback):
    name = profile.get("name") or " ".join(part for part in [profile.get("first_name", ""), profile.get("last_name", "")] if part).strip()
    return name or fallback


def find_identity(psid):
    rows = sb_get("customer_identities", {"provider": "eq.messenger", "provider_user_id": f"eq.{psid}", "select": "customer_id", "limit": "1"})
    return rows[0] if rows else None


def find_identity_by_customer(customer_id):
    rows = sb_get("customer_identities", {"customer_id": f"eq.{customer_id}", "provider": "eq.messenger", "select": "provider_user_id", "limit": "1"})
    return rows[0] if rows else None


def ensure_customer(psid, profile=None):
    profile = profile or get_profile(psid)
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
        sb_patch("customer_identities", {"display_name": name, "raw_profile": profile, "updated_at": now_iso()}, {"provider": "eq.messenger", "provider_user_id": f"eq.{psid}"})
        return customer_id
    customer = sb_post("customers", {**profile_payload, "source": "messenger", "first_seen_at": now_iso(), "last_seen_at": now_iso(), "metadata": {"messenger_psid": psid}})[0]
    sb_post("customer_identities", {"customer_id": customer["id"], "provider": "messenger", "provider_user_id": psid, "display_name": name, "raw_profile": profile})
    return customer["id"]


def save_message(customer_id, message_id, direction, text, attachments, raw, sent_at=None):
    if message_id:
        existing = sb_get("messages", {"provider": "eq.messenger", "provider_message_id": f"eq.{message_id}", "select": "id", "limit": "1"})
        if existing:
            return False
    sent_at = sent_at or now_iso()
    sb_post("messages", {"customer_id": customer_id, "provider": "messenger", "provider_message_id": message_id, "direction": direction, "message_type": "attachment" if attachments else "text", "text": text, "attachments": attachments or [], "raw_event": raw, "sent_at": sent_at})
    sb_patch("customers", {"last_seen_at": now_iso(), "last_message_at": sent_at, "updated_at": now_iso()}, {"id": f"eq.{customer_id}"})
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


def load_dashboard(selected_id):
    customers = sb_get("customers", {"select": "id,display_name,source,first_seen_at,last_seen_at,last_message_at,profile_pic_url,tags,locale,timezone,gender,metadata", "order": "last_seen_at.desc"}, range_header="0-999")
    if customers and not selected_id:
        selected_id = customers[0]["id"]
    recent_messages = sb_get("messages", {"select": "customer_id,direction,text,sent_at", "order": "sent_at.desc", "limit": "5000"})
    latest = {}
    for message in recent_messages:
        latest.setdefault(message["customer_id"], message)
    selected = next((customer for customer in customers if customer["id"] == selected_id), None) if selected_id else None
    messages = []
    if selected:
        messages = sb_get("messages", {"customer_id": f"eq.{selected_id}", "select": "direction,text,message_type,attachments,sent_at", "order": "sent_at.asc", "limit": "200"})
    return customers, latest, selected, messages, selected_id


@app.get("/")
def dashboard():
    if not database_ready():
        return "CRM is online, but database is not configured yet."
    customers, latest, selected, messages, selected_id = load_dashboard(request.args.get("customer"))
    return render_template_string(TEMPLATE, customers=customers, latest_by_customer=latest, selected_customer=selected, selected_messages=messages, selected_customer_id=selected_id)


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
        result = graph_post("me/messages", {"recipient": {"id": identity["provider_user_id"]}, "messaging_type": "RESPONSE", "message": {"text": text}})
        save_message(customer_id, result.get("message_id"), "outbound", text, [], result, now_iso())
    return redirect(f"/?customer={customer_id}", code=303)


@app.post("/admin/import/messenger-conversations")
def import_messenger_conversations():
    conversations = graph_get(f"{META_PAGE_ID}/conversations", {"fields": "participants{id,name},messages.limit(10){id,message,from,to,created_time,attachments}", "limit": "100"})
    imported = 0
    for conversation in conversations.get("data", []):
        people = [p for p in conversation.get("participants", {}).get("data", []) if p.get("id") != META_PAGE_ID]
        if not people:
            continue
        customer_id = ensure_customer(people[0]["id"], {"name": people[0].get("name")})
        for message in conversation.get("messages", {}).get("data", []):
            direction = "outbound" if message.get("from", {}).get("id") == META_PAGE_ID else "inbound"
            if save_message(customer_id, message.get("id"), direction, message.get("message"), message.get("attachments", {}).get("data", []), message, message.get("created_time")):
                imported += 1
    return jsonify({"ok": True, "imported_messages": imported})


TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CRM 客户工作台</title><style>body{margin:0;font-family:Arial,"Microsoft YaHei",sans-serif;background:#f5f6f8;color:#17202a}*{box-sizing:border-box}header{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 20px;background:white;border-bottom:1px solid #d8dee8;font-weight:700}main{display:grid;grid-template-columns:380px 1fr;height:calc(100vh - 57px)}.list{background:white;border-right:1px solid #d8dee8;overflow:auto}.list-title{position:sticky;top:0;background:white;padding:14px 16px;border-bottom:1px solid #edf0f4;color:#5c6773;font-size:13px}.customer{display:grid;grid-template-columns:44px 1fr;gap:12px;padding:14px 16px;border-bottom:1px solid #edf0f4;text-decoration:none;color:inherit}.active{background:#eef7f4;border-left:4px solid #1f8a70;padding-left:12px}.avatar{width:44px;height:44px;border-radius:50%;background:#1f8a70;color:white;display:flex;align-items:center;justify-content:center;font-weight:700;overflow:hidden}.avatar.large{width:72px;height:72px;font-size:24px}.avatar img{width:100%;height:100%;object-fit:cover}.name{font-weight:700;margin-bottom:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.preview{font-size:13px;color:#3e4b57;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.meta{font-size:12px;color:#6a7682;margin-top:5px}.profile{display:flex;flex-direction:column;height:100%;overflow:hidden}.head{display:flex;gap:16px;align-items:center;background:white;border-bottom:1px solid #d8dee8;padding:20px 24px}.details{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;padding:16px 24px}.field{background:white;border:1px solid #d8dee8;border-radius:8px;padding:12px}.label{font-size:12px;color:#6a7682;margin-bottom:8px}.conversation{flex:1;overflow:auto;padding:10px 24px}.messages{display:flex;flex-direction:column;gap:10px}.message{max-width:78%;padding:10px 12px;border:1px solid #d8dee8;border-radius:8px;background:white;line-height:1.45}.outbound{align-self:flex-end;background:#eaf2ff}.inbound{align-self:flex-start}.time{font-size:11px;color:#6a7682;margin-top:6px}.reply{display:grid;grid-template-columns:1fr 96px;gap:10px;background:white;border-top:1px solid #d8dee8;padding:14px 24px}textarea{min-height:44px;border:1px solid #cfd7e2;border-radius:8px;padding:11px;font:inherit}button{border:0;border-radius:8px;background:#1f8a70;color:white;font-weight:700}.empty{margin:24px;background:white;border:1px solid #d8dee8;border-radius:8px;padding:22px}@media(max-width:860px){main{grid-template-columns:1fr;height:auto}.list{max-height:42vh}.details{grid-template-columns:1fr}.reply{grid-template-columns:1fr}}</style></head><body><header><div>CRM 客户工作台</div><div>{{ customers|length }} 个客户</div></header><main><section class="list"><div class="list-title">按最近互动时间排列</div>{% for customer in customers %}{% set latest = latest_by_customer.get(customer.id) %}<a class="customer {% if customer.id == selected_customer_id %}active{% endif %}" href="/?customer={{ customer.id }}"><div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" alt="">{% else %}{{ (customer.display_name or 'C')[:1] }}{% endif %}</div><div><div class="name">{{ customer.display_name or '未命名客户' }}</div><div class="preview">{{ latest.text if latest and latest.text else '暂无文字消息' }}</div><div class="meta">{{ customer.source }} · {{ customer.last_seen_at }}</div></div></a>{% else %}<div class="empty">还没有客户</div>{% endfor %}</section><section>{% if selected_customer %}<div class="profile"><div class="head"><div class="avatar large">{% if selected_customer.profile_pic_url %}<img src="{{ selected_customer.profile_pic_url }}" alt="">{% else %}{{ (selected_customer.display_name or 'C')[:1] }}{% endif %}</div><div><h1>{{ selected_customer.display_name or '未命名客户' }}</h1><div>{{ selected_customer.source }}</div></div></div><div class="details"><div class="field"><div class="label">第一次联系</div>{{ selected_customer.first_seen_at or '-' }}</div><div class="field"><div class="label">最近互动</div>{{ selected_customer.last_seen_at or '-' }}</div><div class="field"><div class="label">最近消息时间</div>{{ selected_customer.last_message_at or '-' }}</div><div class="field"><div class="label">语言</div>{{ selected_customer.locale or '-' }}</div></div><div class="conversation"><h2>聊天记录</h2><div class="messages">{% for message in selected_messages %}<div class="message {{ message.direction }}"><div>{{ message.text if message.text else '[附件或系统消息]' }}</div><div class="time">{{ '客户发来' if message.direction == 'inbound' else '我们回复' }} · {{ message.sent_at }}</div></div>{% else %}<div class="empty">这个客户还没有可显示的聊天记录。</div>{% endfor %}</div></div><form class="reply" method="post" action="/customers/{{ selected_customer.id }}/messages"><textarea name="text" placeholder="输入要发给客户的消息" required></textarea><button type="submit">发送</button></form></div>{% else %}<div class="empty">请选择客户</div>{% endif %}</section></main></body></html>
"""

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
