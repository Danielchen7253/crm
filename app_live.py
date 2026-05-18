import os
from datetime import datetime, timezone

import requests
from flask import Flask, Response, abort, jsonify, render_template_string, request

app = Flask(__name__)

SUPABASE_URL = os.getenv("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
META_VERIFY_TOKEN = os.getenv("META_VERIFY_TOKEN", "")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def database_ready():
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def sb_headers(prefer=None):
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def sb(method, table, payload=None, params=None, prefer=None):
    response = requests.request(
        method,
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=sb_headers(prefer),
        params=params or {},
        json=payload,
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def ensure_customer(psid):
    rows = sb("GET", "customer_identities", params={
        "provider": "eq.messenger",
        "provider_user_id": f"eq.{psid}",
        "select": "customer_id",
        "limit": "1",
    })
    if rows:
        customer_id = rows[0]["customer_id"]
        sb("PATCH", "customers", {"last_seen_at": now_iso(), "updated_at": now_iso()}, {"id": f"eq.{customer_id}"}, "return=representation")
        return customer_id

    name = f"Messenger {psid[-6:]}"
    customer = sb("POST", "customers", {
        "display_name": name,
        "source": "messenger",
        "first_seen_at": now_iso(),
        "last_seen_at": now_iso(),
        "metadata": {"messenger_psid": psid},
    }, prefer="return=representation")[0]
    sb("POST", "customer_identities", {
        "customer_id": customer["id"],
        "provider": "messenger",
        "provider_user_id": psid,
        "display_name": name,
        "raw_profile": {},
    }, prefer="return=representation")
    return customer["id"]


def save_message(customer_id, mid, direction, text, attachments, raw_event, sent_at=None):
    if mid:
        existing = sb("GET", "messages", params={
            "provider": "eq.messenger",
            "provider_message_id": f"eq.{mid}",
            "select": "id",
            "limit": "1",
        })
        if existing:
            return
    sent_at = sent_at or now_iso()
    sb("POST", "messages", {
        "customer_id": customer_id,
        "provider": "messenger",
        "provider_message_id": mid,
        "direction": direction,
        "message_type": "attachment" if attachments else "text",
        "text": text,
        "attachments": attachments or [],
        "raw_event": raw_event,
        "sent_at": sent_at,
    }, prefer="return=representation")
    sb("PATCH", "customers", {"last_seen_at": now_iso(), "last_message_at": sent_at, "updated_at": now_iso()}, {"id": f"eq.{customer_id}"}, "return=representation")


def process_event(event):
    message = event.get("message") or {}
    is_echo = bool(message.get("is_echo"))
    psid = event.get("recipient", {}).get("id") if is_echo else event.get("sender", {}).get("id")
    if not psid:
        return
    customer_id = ensure_customer(psid)
    timestamp = event.get("timestamp")
    sent_at = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat() if timestamp else None
    save_message(customer_id, message.get("mid"), "outbound" if is_echo else "inbound", message.get("text"), message.get("attachments", []), event, sent_at)


@app.get("/")
def home():
    if not database_ready():
        return render_template_string(SETUP_TEMPLATE, configured=False)
    customers = sb("GET", "customers", params={"select": "id,display_name,source,last_seen_at,last_message_at,tags", "order": "last_seen_at.desc", "limit": "100"})
    return render_template_string(DASHBOARD_TEMPLATE, customers=customers)


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
    if not database_ready():
        return jsonify({"ok": False, "error": "database_not_configured"}), 503
    payload = request.get_json(force=True, silent=True) or {}
    if payload.get("object") == "page":
        for entry in payload.get("entry", []):
            for event in entry.get("messaging", []):
                process_event(event)
    return jsonify({"ok": True})


SETUP_TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRM Setup</title><style>body{font-family:Arial,sans-serif;background:#f6f7f9;margin:0;min-height:100vh;display:grid;place-items:center}main{max-width:720px;background:white;border:1px solid #d8dee8;border-radius:8px;padding:28px}code{background:#eef2f7;padding:2px 5px;border-radius:4px}</style></head><body><main><h1>CRM is online</h1><p>Database variables are not configured yet.</p><p>Webhook path: <code>/webhooks/meta</code></p></main></body></html>"""

DASHBOARD_TEMPLATE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CRM</title><style>body{font-family:Arial,sans-serif;margin:0;background:#f6f7f9}header{height:56px;background:white;border-bottom:1px solid #d8dee8;display:flex;align-items:center;padding:0 20px;font-weight:700}.item{background:white;border-bottom:1px solid #edf0f4;padding:14px 20px}.name{font-weight:700}.meta{color:#5c6773;font-size:13px}</style></head><body><header>CRM Customer Inbox</header>{% for c in customers %}<div class="item"><div class="name">{{ c.display_name }}</div><div class="meta">{{ c.source }} - {{ c.last_seen_at }}</div></div>{% else %}<div class="item"><div class="name">No customers yet</div><div class="meta">Messenger customers will appear here automatically.</div></div>{% endfor %}</body></html>"""

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
