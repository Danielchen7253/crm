import hashlib
import hmac
import os
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


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def supabase_headers(prefer=None):
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        raise RuntimeError("Supabase environment variables are missing.")

    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    return headers


def supabase_get(table, params=None):
    response = requests.get(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers(),
        params=params or {},
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def supabase_post(table, payload, prefer="return=representation"):
    response = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers(prefer),
        json=payload,
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def supabase_patch(table, payload, params):
    response = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=supabase_headers("return=representation"),
        params=params,
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

    expected = hmac.new(
        META_APP_SECRET.encode("utf-8"),
        raw_body,
        hashlib.sha256,
    ).hexdigest()
    return hmac.compare_digest(signature, f"sha256={expected}")


def graph_get(path, params=None):
    params = params or {}
    params["access_token"] = META_PAGE_ACCESS_TOKEN
    response = requests.get(
        f"https://graph.facebook.com/{GRAPH_API_VERSION}/{path.lstrip('/')}",
        params=params,
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def get_messenger_profile(psid):
    if not META_PAGE_ACCESS_TOKEN:
        return {}

    try:
        return graph_get(psid, {"fields": "first_name,last_name,profile_pic,locale,timezone,gender"})
    except requests.RequestException:
        return {}


def find_identity(provider, provider_user_id):
    rows = supabase_get(
        "customer_identities",
        {
            "provider": f"eq.{provider}",
            "provider_user_id": f"eq.{provider_user_id}",
            "select": "customer_id,display_name,raw_profile",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


def build_display_name(profile, fallback):
    first_name = profile.get("first_name", "")
    last_name = profile.get("last_name", "")
    full_name = " ".join(part for part in [first_name, last_name] if part).strip()
    return full_name or fallback


def ensure_customer_from_messenger(psid):
    identity = find_identity("messenger", psid)
    if identity:
        customer_id = identity["customer_id"]
        supabase_patch(
            "customers",
            {"last_seen_at": now_iso(), "updated_at": now_iso()},
            {"id": f"eq.{customer_id}"},
        )
        return customer_id

    profile = get_messenger_profile(psid)
    display_name = build_display_name(profile, f"Messenger {psid[-6:]}")
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
        {
            "customer_id": customer["id"],
            "provider": "messenger",
            "provider_user_id": psid,
            "display_name": display_name,
            "raw_profile": profile,
        },
    )
    return customer["id"]


def save_message(customer_id, provider_message_id, direction, text, attachments, raw_event, sent_at=None):
    if provider_message_id:
        existing = supabase_get(
            "messages",
            {
                "provider": "eq.messenger",
                "provider_message_id": f"eq.{provider_message_id}",
                "select": "id",
                "limit": "1",
            },
        )
        if existing:
            return

    payload = {
        "customer_id": customer_id,
        "provider": "messenger",
        "provider_message_id": provider_message_id,
        "direction": direction,
        "message_type": "attachment" if attachments else "text",
        "text": text,
        "attachments": attachments or [],
        "raw_event": raw_event,
        "sent_at": sent_at or now_iso(),
    }

    supabase_post("messages", payload)
    supabase_patch(
        "customers",
        {"last_seen_at": now_iso(), "last_message_at": payload["sent_at"], "updated_at": now_iso()},
        {"id": f"eq.{customer_id}"},
    )


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
    sent_at = None
    if timestamp:
        sent_at = datetime.fromtimestamp(timestamp / 1000, tz=timezone.utc).isoformat()

    save_message(
        customer_id=customer_id,
        provider_message_id=message.get("mid"),
        direction=direction,
        text=message.get("text"),
        attachments=message.get("attachments", []),
        raw_event=event,
        sent_at=sent_at,
    )


@app.get("/")
def dashboard():
    customers = supabase_get(
        "customers",
        {
            "select": "id,display_name,source,last_seen_at,last_message_at,profile_pic_url,tags",
            "order": "last_seen_at.desc",
            "limit": "100",
        },
    )
    messages = supabase_get(
        "messages",
        {
            "select": "customer_id,direction,text,sent_at",
            "order": "sent_at.desc",
            "limit": "100",
        },
    )
    latest_by_customer = {}
    for message in messages:
        latest_by_customer.setdefault(message["customer_id"], message)

    return render_template_string(
        DASHBOARD_TEMPLATE,
        customers=customers,
        latest_by_customer=latest_by_customer,
    )


@app.get("/health")
def health():
    return jsonify({"ok": True})


@app.get("/webhooks/meta")
def verify_webhook():
    mode = request.args.get("hub.mode")
    token = request.args.get("hub.verify_token")
    challenge = request.args.get("hub.challenge")

    if mode == "subscribe" and token == META_VERIFY_TOKEN:
        return Response(challenge or "", status=200, mimetype="text/plain")

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


@app.post("/admin/import/messenger-conversations")
def import_messenger_conversations():
    if not META_PAGE_ID or not META_PAGE_ACCESS_TOKEN:
        return jsonify({"error": "META_PAGE_ID and META_PAGE_ACCESS_TOKEN are required."}), 400

    imported = 0
    conversations = graph_get(
        f"{META_PAGE_ID}/conversations",
        {"fields": "participants,messages.limit(25){id,message,from,to,created_time,attachments}", "limit": "50"},
    )

    for conversation in conversations.get("data", []):
        participants = conversation.get("participants", {}).get("data", [])
        customer_participants = [p for p in participants if p.get("id") != META_PAGE_ID]
        if not customer_participants:
            continue

        psid = customer_participants[0]["id"]
        customer_id = ensure_customer_from_messenger(psid)
        for message in conversation.get("messages", {}).get("data", []):
            from_id = message.get("from", {}).get("id")
            direction = "outbound" if from_id == META_PAGE_ID else "inbound"
            save_message(
                customer_id=customer_id,
                provider_message_id=message.get("id"),
                direction=direction,
                text=message.get("message"),
                attachments=message.get("attachments", {}).get("data", []),
                raw_event=message,
                sent_at=message.get("created_time"),
            )
            imported += 1

    return jsonify({"ok": True, "imported_messages": imported})


DASHBOARD_TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CRM Customer Inbox</title>
  <style>
    :root { font-family: Arial, sans-serif; background: #f6f7f9; color: #17202a; }
    body { margin: 0; }
    header { height: 56px; display: flex; align-items: center; padding: 0 20px; background: #fff; border-bottom: 1px solid #d8dee8; font-weight: 700; }
    main { display: grid; grid-template-columns: 360px 1fr; min-height: calc(100vh - 57px); }
    .list { border-right: 1px solid #d8dee8; background: #fff; overflow: auto; }
    .customer { display: grid; grid-template-columns: 44px 1fr; gap: 12px; padding: 14px 16px; border-bottom: 1px solid #edf0f4; text-decoration: none; color: inherit; }
    .avatar { width: 44px; height: 44px; border-radius: 50%; background: #1f8a70; color: white; display: flex; align-items: center; justify-content: center; font-weight: 700; overflow: hidden; }
    .avatar img { width: 100%; height: 100%; object-fit: cover; }
    .name { font-weight: 700; margin-bottom: 5px; }
    .meta, .preview { font-size: 13px; color: #5c6773; line-height: 1.35; }
    .workspace { padding: 22px; overflow: auto; }
    .empty { max-width: 620px; background: #fff; border: 1px solid #d8dee8; border-radius: 8px; padding: 22px; }
    code { background: #eef2f7; padding: 2px 5px; border-radius: 4px; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; } .workspace { display: none; } .list { border-right: 0; } }
  </style>
</head>
<body>
  <header>CRM Customer Inbox</header>
  <main>
    <section class="list">
      {% for customer in customers %}
      {% set latest = latest_by_customer.get(customer.id) %}
      <a class="customer" href="#">
        <div class="avatar">
          {% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" alt="">{% else %}{{ (customer.display_name or 'C')[:1] }}{% endif %}
        </div>
        <div>
          <div class="name">{{ customer.display_name or 'Unnamed customer' }}</div>
          <div class="preview">{{ latest.text if latest and latest.text else 'No text message yet' }}</div>
          <div class="meta">{{ customer.source }} - {{ customer.last_seen_at }}</div>
        </div>
      </a>
      {% else %}
      <div class="customer">
        <div class="avatar">0</div>
        <div>
          <div class="name">No customers yet</div>
          <div class="preview">After Messenger webhook is connected, customers will appear here automatically.</div>
        </div>
      </div>
      {% endfor %}
    </section>
    <section class="workspace">
      <div class="empty">
        <h2>Messenger sync is ready</h2>
        <p>This first version receives Messenger messages and stores product inquiries as customer records in Supabase.</p>
        <p>Meta Webhook path:</p>
        <p><code>/webhooks/meta</code></p>
        <p>Run <code>schema.sql</code> in Supabase before using the webhook.</p>
      </div>
    </section>
  </main>
</body>
</html>
"""


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.getenv("PORT", "5000")), debug=True)
