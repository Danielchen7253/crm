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
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4o-mini")

FIXED_REPLY_RULES = [
    {
        "category": "shipping",
        "confidence": 0.98,
        "keywords": [
            "ship",
            "shipping",
            "delivery",
            "deliver",
            "send",
            "arrive",
            "when",
            "\u591a\u4e45",
            "\u53d1\u8d27",
            "\u9001\u8d27",
            "\u914d\u9001",
            "\u4ec0\u4e48\u65f6\u5019",
        ],
        "reply": "Orders paid before 3 PM ship the same day. Orders paid after 3 PM ship the next business day. Holidays may delay shipping.",
    },
    {
        "category": "pickup_address",
        "confidence": 0.98,
        "keywords": [
            "pickup",
            "pick up",
            "address",
            "location",
            "where",
            "\u63d0\u8d27",
            "\u81ea\u53d6",
            "\u5730\u5740",
            "\u54ea\u91cc",
            "\u4f4d\u7f6e",
        ],
        "reply": "Pickup address: 755 International Blvd, Houston, TX 77024.",
    },
]

LEARNING_ONLY_KEYWORDS = [
    "model",
    "part number",
    "size",
    "measure",
    "measurement",
    "dimension",
    "photo",
    "picture",
    "image",
    "fit",
    "fits",
    "compatible",
    "compatibility",
    "\u578b\u53f7",
    "\u5c3a\u5bf8",
    "\u6d4b\u91cf",
    "\u7167\u7247",
    "\u56fe\u7247",
    "\u9002\u914d",
    "\u517c\u5bb9",
]


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
        page = sb_get(table, params, range_header=f"{start}-{start + page_size - 1}")
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
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def graph_get_url(url):
    response = requests.get(url, timeout=30)
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
        return graph_get(psid, {"fields": "first_name,last_name,name,profile_pic,picture,locale,timezone,gender"})
    except requests.RequestException:
        return {}


def profile_picture_url(profile):
    if not isinstance(profile, dict):
        return None
    direct_url = profile.get("profile_pic_url") or profile.get("profile_pic")
    if direct_url:
        return direct_url
    picture = profile.get("picture")
    if isinstance(picture, dict):
        data = picture.get("data")
        if isinstance(data, dict) and data.get("url"):
            return data["url"]
        if picture.get("url"):
            return picture["url"]
    return None


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
    profile = {**known_profile, **fetched_profile}
    known_picture_url = profile_picture_url(known_profile)
    if known_picture_url and not profile_picture_url(profile):
        profile["profile_pic_url"] = known_picture_url
    return profile


def ensure_customer(psid, profile=None):
    profile = complete_profile(psid, profile)
    name = display_name(profile, f"Messenger {psid[-6:]}")
    identity = find_identity(psid)
    profile_payload = {"display_name": name, "updated_at": now_iso()}
    picture_url = profile_picture_url(profile)
    if picture_url:
        profile_payload["profile_pic_url"] = picture_url
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
        return customer_id, False

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
    return customer["id"], True


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
    customer_id, _ = ensure_customer(psid)
    save_message(customer_id, message.get("mid"), direction, message.get("text"), message.get("attachments", []), event, sent_at)


def attachment_kind(value, inherited_type=None):
    mime_type = str(value.get("mime_type") or "").lower()
    item_type = value.get("type") or inherited_type or "file"
    if mime_type.startswith("image/") or isinstance(value.get("image_data"), dict):
        return "image"
    if mime_type.startswith("audio/"):
        return "audio"
    if mime_type.startswith("video/"):
        return "video"
    return item_type if item_type in {"image", "audio", "video", "file"} else "file"


def first_http_url(*values):
    for value in values:
        if isinstance(value, str) and value.startswith("http"):
            return value
    return None


def best_attachment_url(value, kind):
    payload = value.get("payload") if isinstance(value.get("payload"), dict) else {}
    image_data = value.get("image_data") if isinstance(value.get("image_data"), dict) else {}
    if kind == "image":
        return first_http_url(
            image_data.get("animated_gif_url"),
            image_data.get("raw_gif_image"),
            image_data.get("url"),
            image_data.get("animated_webp_url"),
            image_data.get("raw_webp_image"),
            value.get("url"),
            payload.get("url"),
            image_data.get("preview_url"),
            value.get("preview_url"),
            payload.get("preview_url"),
        )
    return first_http_url(
        value.get("file_url"),
        value.get("url"),
        payload.get("url"),
        value.get("src"),
        payload.get("src"),
        value.get("preview_url"),
        payload.get("preview_url"),
    )


def collect_attachment_items(value, inherited_type=None):
    items = []
    if isinstance(value, dict):
        kind = attachment_kind(value, inherited_type)
        url = best_attachment_url(value, kind)
        if url:
            lower_url = url.lower()
            if kind == "file":
                if any(ext in lower_url for ext in [".jpg", ".jpeg", ".png", ".gif", ".webp"]):
                    kind = "image"
                elif any(ext in lower_url for ext in [".mp3", ".m4a", ".aac", ".wav", ".ogg", ".oga", ".amr", ".opus", ".mp4"]):
                    kind = "audio"
            items.append({"type": kind, "url": url})
        skipped_keys = {"payload", "image_data"} if url else set()
        for key, child in value.items():
            if key not in skipped_keys:
                items.extend(collect_attachment_items(child, kind))
    elif isinstance(value, list):
        for item in value:
            items.extend(collect_attachment_items(item, inherited_type))

    unique = []
    seen = set()
    for item in items:
        key = (item["type"], item["url"])
        if key not in seen:
            unique.append(item)
            seen.add(key)
    return unique


def decorate_message(message):
    attachment_items = collect_attachment_items(message.get("attachments") or [])
    message["image_attachments"] = [item for item in attachment_items if item["type"] == "image"]
    message["audio_attachments"] = [item for item in attachment_items if item["type"] == "audio"]
    message["file_attachments"] = [item for item in attachment_items if item["type"] not in {"image", "audio"}]
    message["has_attachments"] = bool(attachment_items)
    return message


def fixed_reply_for(text):
    normalized = (text or "").lower()
    matches = []
    for rule in FIXED_REPLY_RULES:
        if any(keyword.lower() in normalized for keyword in rule["keywords"]):
            matches.append(rule)
    if not matches:
        return None

    draft_text = "\n\n".join(rule["reply"] for rule in matches)
    return {
        "source": "rules",
        "category": "+".join(rule["category"] for rule in matches),
        "confidence": max(rule["confidence"] for rule in matches),
        "draft_text": draft_text,
    }


def should_learn_without_draft(message):
    text = (message.get("text") or "").lower()
    if message.get("has_attachments"):
        return True
    return any(keyword.lower() in text for keyword in LEARNING_ONLY_KEYWORDS)


def learning_only_reply_for(message):
    return {
        "source": "learning_only",
        "category": "model_photo_request",
        "confidence": 0,
        "draft_text": "",
        "status": "learning_only",
    }


def recent_conversation_text(messages, limit=12):
    lines = []
    for message in messages[-limit:]:
        speaker = "Customer" if message.get("direction") == "inbound" else "You"
        body = message.get("text") or "[attachment]"
        lines.append(f"{speaker}: {body}")
    return "\n".join(lines)


def parse_openai_text(payload):
    if payload.get("output_text"):
        return payload["output_text"].strip()
    parts = []
    for item in payload.get("output", []):
        for content in item.get("content", []):
            text = content.get("text")
            if text:
                parts.append(text)
    return "\n".join(parts).strip()


def openai_reply_for(customer, messages):
    if not OPENAI_API_KEY:
        return None

    prompt = {
        "customer_name": customer.get("display_name"),
        "conversation": recent_conversation_text(messages),
        "business_facts": [
            "Orders paid before 3 PM ship the same day.",
            "Orders paid after 3 PM ship the next business day.",
            "Holidays may delay shipping.",
            "Pickup address: 755 International Blvd, Houston, TX 77024.",
        ],
    }
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": OPENAI_MODEL,
            "input": [
                {
                    "role": "system",
                    "content": (
                        "You draft short Messenger replies for a refrigerator gasket parts seller. "
                        "Be practical, polite, direct, and sales-oriented. "
                        "Do not promise inventory, price, shipping, or compatibility unless the conversation already confirms it. "
                        "Return only the reply text."
                    ),
                },
                {"role": "user", "content": str(prompt)},
            ],
        },
        timeout=25,
    )
    response.raise_for_status()
    text = parse_openai_text(response.json())
    if not text:
        return None
    return {"source": "openai", "category": "ai_draft", "confidence": 0.68, "draft_text": text}


def fallback_reply_for(message):
    text = "Thanks for your message. I will check it and get back to you shortly."
    return {"source": "fallback", "category": "draft_only", "confidence": 0.35, "draft_text": text}


def build_ai_reply(customer, messages, inbound_message):
    rule_reply = fixed_reply_for(inbound_message.get("text"))
    if rule_reply:
        return rule_reply
    if should_learn_without_draft(inbound_message):
        return learning_only_reply_for(inbound_message)
    try:
        ai_reply = openai_reply_for(customer, messages)
        if ai_reply:
            return ai_reply
    except requests.RequestException:
        pass
    return fallback_reply_for(inbound_message)


def load_ai_draft(customer, messages):
    if not customer or not messages:
        return None
    latest_message = messages[-1]
    if latest_message.get("direction") != "inbound" or not latest_message.get("id"):
        return None

    existing = sb_get(
        "ai_reply_drafts",
        {"message_id": f"eq.{latest_message['id']}", "select": "*", "limit": "1"},
    )
    if existing:
        return existing[0]

    draft = build_ai_reply(customer, messages, latest_message)
    payload = {
        "customer_id": customer["id"],
        "message_id": latest_message["id"],
        "source": draft["source"],
        "category": draft["category"],
        "confidence": draft["confidence"],
        "prompt": {
            "customer_name": customer.get("display_name"),
            "latest_message_text": latest_message.get("text"),
            "openai_model": OPENAI_MODEL if OPENAI_API_KEY else None,
        },
        "draft_text": draft["draft_text"],
        "status": draft.get("status", "drafted"),
    }
    try:
        return sb_post("ai_reply_drafts", payload)[0]
    except requests.RequestException:
        existing = sb_get(
            "ai_reply_drafts",
            {"message_id": f"eq.{latest_message['id']}", "select": "*", "limit": "1"},
        )
        return existing[0] if existing else None


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
    recent_messages = sb_get("messages", {"select": "customer_id,direction,text,sent_at", "order": "sent_at.desc", "limit": "10000"})
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
                "select": "id,direction,text,message_type,attachments,sent_at",
                "order": "sent_at.desc",
                "limit": "500",
            },
        )
        messages = [decorate_message(message) for message in reversed(newest_messages)]
    return customers, latest, selected, messages, selected_id


def import_conversation(conversation):
    people = [p for p in conversation.get("participants", {}).get("data", []) if p.get("id") != META_PAGE_ID]
    if not people:
        return {"customer_created": 0, "messages_imported": 0}
    customer_id, created = ensure_customer(people[0]["id"], people[0])
    imported = 0
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
    return {"customer_created": 1 if created else 0, "messages_imported": imported}


def sync_messenger_conversations_paginated(max_pages=200, page_limit=100, messages_limit=25):
    if not META_PAGE_ID or not META_PAGE_ACCESS_TOKEN:
        raise RuntimeError("META_PAGE_ID and META_PAGE_ACCESS_TOKEN are required.")
    fields = f"participants{{id,name,profile_pic,picture}},messages.limit({messages_limit}){{id,message,from,to,created_time,attachments}}"
    page = graph_get(f"{META_PAGE_ID}/conversations", {"fields": fields, "limit": str(page_limit)})
    pages = 0
    conversations_seen = 0
    customers_created = 0
    messages_imported = 0
    while page and pages < max_pages:
        pages += 1
        conversations = page.get("data", [])
        conversations_seen += len(conversations)
        for conversation in conversations:
            result = import_conversation(conversation)
            customers_created += result["customer_created"]
            messages_imported += result["messages_imported"]
        next_url = page.get("paging", {}).get("next")
        page = graph_get_url(next_url) if next_url else None
    return {
        "pages": pages,
        "conversations_seen": conversations_seen,
        "customers_created": customers_created,
        "messages_imported": messages_imported,
        "stopped_by_max_pages": bool(page),
    }


def safe_graph_diagnostic(path, params=None):
    try:
        return {"ok": True, "data": graph_get(path, params or {})}
    except requests.RequestException as error:
        response = getattr(error, "response", None)
        detail = None
        if response is not None:
            try:
                detail = response.json()
            except ValueError:
                detail = response.text[:500]
        return {"ok": False, "error": str(error).replace(META_PAGE_ACCESS_TOKEN, "[redacted]"), "detail": detail}


@app.get("/admin/meta/diagnostics")
def meta_diagnostics():
    page_result = safe_graph_diagnostic(META_PAGE_ID, {"fields": "id,name,category,link"}) if META_PAGE_ID else {"ok": False, "error": "META_PAGE_ID missing"}
    conversations_result = safe_graph_diagnostic(
        f"{META_PAGE_ID}/conversations",
        {"fields": "id,updated_time,participants{id,name}", "limit": "100"},
    ) if META_PAGE_ID else {"ok": False, "error": "META_PAGE_ID missing"}
    conversations = conversations_result.get("data", {}) if conversations_result.get("ok") else {}
    return jsonify(
        {
            "ok": True,
            "configured": {
                "page_id_present": bool(META_PAGE_ID),
                "page_token_present": bool(META_PAGE_ACCESS_TOKEN),
                "graph_api_version": GRAPH_API_VERSION,
            },
            "me": safe_graph_diagnostic("me", {"fields": "id,name"}),
            "page": page_result,
            "page_conversations": conversations_result,
            "page_conversations_summary": {
                "count_returned": len(conversations.get("data", [])) if isinstance(conversations, dict) else 0,
                "has_next_page": bool(conversations.get("paging", {}).get("next")) if isinstance(conversations, dict) else False,
            },
        }
    )


@app.post("/admin/backfill/messenger-profiles")
def backfill_messenger_profiles():
    if not META_PAGE_ACCESS_TOKEN:
        return jsonify({"ok": False, "error": "META_PAGE_ACCESS_TOKEN missing"}), 400

    limit = max(1, min(int(request.args.get("limit", "500")), 5000))
    identities = sb_get_all(
        "customer_identities",
        {
            "provider": "eq.messenger",
            "select": "customer_id,provider_user_id,raw_profile",
            "limit": str(limit),
        },
        max_rows=limit,
    )
    checked = 0
    updated = 0
    skipped = 0
    errors = []

    for identity in identities:
        psid = identity.get("provider_user_id")
        customer_id = identity.get("customer_id")
        if not psid or not customer_id:
            skipped += 1
            continue
        checked += 1
        try:
            profile = complete_profile(psid, identity.get("raw_profile") or {})
            name = display_name(profile, f"Messenger {psid[-6:]}")
            picture_url = profile_picture_url(profile)
            payload = {"display_name": name, "updated_at": now_iso()}
            if picture_url:
                payload["profile_pic_url"] = picture_url
            if profile.get("locale"):
                payload["locale"] = profile["locale"]
            if profile.get("timezone") is not None:
                payload["timezone"] = str(profile["timezone"])
            if profile.get("gender"):
                payload["gender"] = profile["gender"]
            sb_patch("customers", payload, {"id": f"eq.{customer_id}"})
            sb_patch(
                "customer_identities",
                {"display_name": name, "raw_profile": profile, "updated_at": now_iso()},
                {"provider": "eq.messenger", "provider_user_id": f"eq.{psid}"},
            )
            updated += 1
        except requests.RequestException as error:
            errors.append({"psid": psid, "error": str(error)})
        except Exception as error:
            errors.append({"psid": psid, "error": str(error)})

    return jsonify(
        {
            "ok": True,
            "checked": checked,
            "updated": updated,
            "skipped": skipped,
            "errors": errors[:20],
            "error_count": len(errors),
        }
    )


@app.get("/")
def dashboard():
    if not database_ready():
        return "CRM is online, but database is not configured yet."
    customers, latest, selected, messages, selected_id = load_dashboard(request.args.get("customer"))
    ai_draft = load_ai_draft(selected, messages)
    return render_template_string(
        TEMPLATE,
        customers=customers,
        latest_by_customer=latest,
        selected_customer=selected,
        selected_messages=messages,
        selected_customer_id=selected_id,
        ai_draft=ai_draft,
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
    ai_draft_id = request.form.get("ai_draft_id", "").strip()
    identity = find_identity_by_customer(customer_id)
    wants_json = request.headers.get("X-Requested-With") == "fetch" or "application/json" in request.headers.get("Accept", "")
    sent_at = now_iso()
    if not text:
        if wants_json:
            return jsonify({"ok": False, "error": "Message text is required."}), 400
        return redirect(f"/?customer={customer_id}", code=303)
    if not identity:
        if wants_json:
            return jsonify({"ok": False, "error": "Customer messaging identity was not found."}), 400
        return redirect(f"/?customer={customer_id}", code=303)
    if text and identity:
        result = graph_post(
            "me/messages",
            {"recipient": {"id": identity["provider_user_id"]}, "messaging_type": "RESPONSE", "message": {"text": text}},
        )
        message_id = result.get("message_id")
        save_message(customer_id, message_id, "outbound", text, [], result, sent_at)
        if ai_draft_id:
            sb_patch(
                "ai_reply_drafts",
                {"final_text": text, "status": "sent", "updated_at": now_iso()},
                {"id": f"eq.{ai_draft_id}"},
            )
        if wants_json:
            return jsonify({"ok": True, "message": {"direction": "outbound", "text": text, "sent_at": sent_at, "provider_message_id": message_id}})
    return redirect(f"/?customer={customer_id}", code=303)


@app.post("/admin/import/messenger-conversations")
def import_messenger_conversations():
    try:
        max_pages = max(1, min(int(request.args.get("max_pages", "200")), 500))
        page_limit = max(1, min(int(request.args.get("limit", "100")), 100))
        messages_limit = max(1, min(int(request.args.get("messages_limit", "25")), 100))
        result = sync_messenger_conversations_paginated(max_pages, page_limit, messages_limit)
    except RuntimeError as error:
        return jsonify({"ok": False, "error": str(error)}), 400
    except requests.RequestException as error:
        return jsonify({"ok": False, "error": str(error)}), 502
    return jsonify({"ok": True, **result})


TEMPLATE = """
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CRM \u5ba2\u6237\u5de5\u4f5c\u53f0</title>
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
    .attachment-audio { width: min(360px, 100%); height: 42px; display: block; }
    .attachment-file { display: inline-flex; align-items: center; min-height: 34px; border: 1px solid #c7d7d2; border-radius: 8px; color: #17634f; background: #f7fbfa; padding: 7px 10px; font-size: 13px; text-decoration: none; word-break: break-all; }
    .time { color: #6a7682; font-size: 11px; margin-top: 6px; }
    .reply { display: grid; grid-template-columns: minmax(0, 1fr) 108px; gap: 12px; align-items: stretch; background: #fff; border-top: 1px solid #d8dee8; padding: 16px 24px; }
    .reply-body { min-width: 0; display: grid; gap: 8px; }
    .ai-draft { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: #3e4b57; font-size: 12px; }
    .ai-badge { border: 1px solid #c7d7d2; background: #eef7f4; color: #17634f; border-radius: 999px; padding: 4px 9px; font-weight: 700; }
    .ai-note { color: #6a7682; }
    textarea { width: 100%; min-height: 104px; max-height: 220px; resize: vertical; border: 1px solid #cfd7e2; border-radius: 8px; padding: 12px 13px; font: inherit; line-height: 1.4; }
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
      <div class="sidebar-head">\u5ba2\u6237 {{ customers|length }}</div>
      {% for customer in customers %}
      <a class="customer {% if customer.id == selected_customer_id %}active{% endif %}" href="/?customer={{ customer.id }}" title="{{ customer.display_name or '\u672a\u547d\u540d\u5ba2\u6237' }}">
        <div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" alt="">{% else %}{{ (customer.display_name or 'C')[:1] }}{% endif %}</div>
        <div class="customer-name">{{ customer.display_name or '\u672a\u547d\u540d\u5ba2\u6237' }}</div>
      </a>
      {% else %}
      <div class="empty">\u8fd8\u6ca1\u6709\u5ba2\u6237</div>
      {% endfor %}
    </aside>
    <section class="work">
      {% if selected_customer %}
      <header class="profile">
        <div class="profile-main">
          <div class="avatar large">{% if selected_customer.profile_pic_url %}<img src="{{ selected_customer.profile_pic_url }}" alt="">{% else %}{{ (selected_customer.display_name or 'C')[:1] }}{% endif %}</div>
          <div>
            <h1>{{ selected_customer.display_name or '\u672a\u547d\u540d\u5ba2\u6237' }}</h1>
            <div class="pill-row">
              <span class="pill tag">{{ selected_customer.source }}</span>
              <span class="pill">\u7b2c\u4e00\u6b21\u8054\u7cfb {{ selected_customer.first_seen_at or '-' }}</span>
              <span class="pill">\u6700\u8fd1\u4e92\u52a8 {{ selected_customer.last_seen_at or '-' }}</span>
              <span class="pill">\u6700\u540e\u6d88\u606f {{ selected_customer.last_message_at or '-' }}</span>
              <span class="pill">\u8bed\u8a00 {{ selected_customer.locale or '-' }}</span>
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
            {% if message.image_attachments or message.audio_attachments or message.file_attachments %}
            <div class="attachment-list">
              {% for item in message.image_attachments %}
              <a href="{{ item.url }}" target="_blank" rel="noopener"><img class="attachment-image" src="{{ item.url }}" alt="\u5ba2\u6237\u53d1\u9001\u7684\u56fe\u7247" loading="lazy"></a>
              {% endfor %}
              {% for item in message.audio_attachments %}
              <audio class="attachment-audio" controls preload="metadata" src="{{ item.url }}"></audio>
              {% endfor %}
              {% for item in message.file_attachments %}
              <a class="attachment-file" href="{{ item.url }}" target="_blank" rel="noopener">\u6253\u5f00\u9644\u4ef6</a>
              {% endfor %}
            </div>
            {% endif %}
            {% if not message.text and not message.has_attachments %}<div>[\u9644\u4ef6\u6216\u7cfb\u7edf\u6d88\u606f]</div>{% endif %}
            <div class="time">{{ '\u5ba2\u6237\u53d1\u6765' if message.direction == 'inbound' else '\u6211\u4eec\u56de\u590d' }} \xb7 {{ message.sent_at }}</div>
          </div>
          {% else %}
          <div class="empty">\u8fd9\u4e2a\u5ba2\u6237\u8fd8\u6ca1\u6709\u53ef\u663e\u793a\u7684\u804a\u5929\u8bb0\u5f55\u3002</div>
          {% endfor %}
        </div>
      </section>
      <form class="reply" method="post" action="/customers/{{ selected_customer.id }}/messages">
        <div class="reply-body">
          {% if ai_draft %}
          <div class="ai-draft">
            {% if ai_draft.status == 'learning_only' %}
            <span class="ai-badge">AI\u5b66\u4e60\u4e2d</span>
            <span>{{ ai_draft.category }}</span>
            <span class="ai-note">\u8fd9\u7c7b\u95ee\u9898\u6682\u65f6\u4e0d\u81ea\u52a8\u751f\u6210\u56de\u590d\uff0c\u53d1\u9001\u540e\u53ea\u7528\u4e8e\u5b66\u4e60</span>
            {% else %}
            <span class="ai-badge">AI\u5efa\u8bae</span>
            <span>{{ ai_draft.category }}</span>
            <span class="ai-note">\u7f6e\u4fe1\u5ea6 {{ '%.0f'|format((ai_draft.confidence or 0) * 100) }}%\uff0c\u53d1\u9001\u524d\u53ef\u4fee\u6539</span>
            {% endif %}
          </div>
          <input type="hidden" name="ai_draft_id" value="{{ ai_draft.id }}">
          {% endif %}
          <textarea name="text" placeholder="\u8f93\u5165\u8981\u53d1\u7ed9\u5ba2\u6237\u7684\u6d88\u606f" required autofocus>{{ ai_draft.draft_text if ai_draft else '' }}</textarea>
        </div>
        <button type="submit">\u53d1\u9001</button>
      </form>
      {% else %}
      <div class="empty">\u8bf7\u9009\u62e9\u5ba2\u6237</div>
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
