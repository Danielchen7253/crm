"""Local browser-extension capture endpoint for private Facebook customers."""

import hashlib
import os
from datetime import datetime, timezone

from flask import jsonify, request

import app_live_new


app = app_live_new.app
crm_module = app_live_new.crm_module

CAPTURE_TOKEN = os.getenv("CRM_CAPTURE_TOKEN", "")
ALLOWED_SOURCES = {"private_messenger", "marketplace", "facebook", "instagram", "tiktok"}


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def cors_response(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-CRM-Capture-Token"
    response.headers["Access-Control-Allow-Methods"] = "POST, OPTIONS"
    return response


def clean_text(value, limit=500):
    text = " ".join(str(value or "").split())
    return text[:limit]


def stable_hash(*parts):
    raw = "|".join(clean_text(part, 2000) for part in parts if part)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def capture_authorized():
    if not CAPTURE_TOKEN:
        return False
    supplied = request.headers.get("X-CRM-Capture-Token") or request.args.get("token") or ""
    return supplied == CAPTURE_TOKEN


def provider_user_id(source, item):
    for key in ("profile_url", "conversation_url", "thread_url"):
        if item.get(key):
            return clean_text(item[key], 1000)
    return f"capture_{stable_hash(source, item.get('display_name'), item.get('page_url'))[:24]}"


def find_identity(provider, external_id):
    rows = crm_module.sb_get(
        "customer_identities",
        {
            "provider": f"eq.{provider}",
            "provider_user_id": f"eq.{external_id}",
            "select": "customer_id,raw_profile",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


def merge_metadata(existing, item):
    metadata = existing if isinstance(existing, dict) else {}
    for key in (
        "profile_url",
        "conversation_url",
        "thread_url",
        "page_url",
        "page_title",
        "marketplace_item_url",
        "marketplace_item_title",
    ):
        value = clean_text(item.get(key), 1000)
        if value:
            metadata[key] = value
    metadata["captured_by"] = "facebook_customer_capture_extension"
    metadata["captured_at"] = now_iso()
    return metadata


def normalized_messages(item, latest_message, captured_at):
    raw_messages = item.get("messages")
    messages = raw_messages if isinstance(raw_messages, list) else []
    normalized = []

    for index, message in enumerate(messages[:200]):
        if not isinstance(message, dict):
            continue
        text = clean_text(message.get("text") or message.get("body"), 4000)
        if not text:
            continue
        normalized.append(
            {
                "text": text,
                "direction": clean_text(message.get("direction"), 40) or "inbound",
                "message_type": clean_text(message.get("message_type"), 40) or "text",
                "sent_at": clean_text(message.get("sent_at"), 80) or captured_at,
                "index": index,
                "raw": message,
            }
        )

    if latest_message and not any(message["text"] == latest_message for message in normalized):
        normalized.append(
            {
                "text": latest_message,
                "direction": "inbound",
                "message_type": "text",
                "sent_at": captured_at,
                "index": len(normalized),
                "raw": {"text": latest_message},
            }
        )

    return normalized


def upsert_customer(item):
    source = clean_text(item.get("source"), 80) or "facebook"
    if source not in ALLOWED_SOURCES:
        source = "facebook"
    external_id = provider_user_id(source, item)
    identity = find_identity(source, external_id)

    display_name = clean_text(item.get("display_name"), 160) or "Facebook Customer"
    profile_pic_url = clean_text(item.get("profile_pic_url"), 2000)
    latest_message = clean_text(item.get("latest_message"), 4000)
    captured_at = clean_text(item.get("captured_at"), 80) or now_iso()
    raw_profile = {
        "display_name": display_name,
        "profile_pic_url": profile_pic_url,
        "latest_message": latest_message,
        "source": source,
        "captured_at": captured_at,
        "raw": item,
    }

    customer_payload = {
        "display_name": display_name,
        "source": source,
        "last_seen_at": now_iso(),
        "updated_at": now_iso(),
        "metadata": merge_metadata((identity or {}).get("raw_profile", {}).get("metadata"), item),
    }
    if profile_pic_url:
        customer_payload["profile_pic_url"] = profile_pic_url
    if latest_message:
        customer_payload["last_message_at"] = captured_at

    created = False
    if identity:
        customer_id = identity["customer_id"]
        crm_module.sb_patch("customers", customer_payload, {"id": f"eq.{customer_id}"})
        crm_module.sb_patch(
            "customer_identities",
            {"display_name": display_name, "raw_profile": raw_profile, "updated_at": now_iso()},
            {"provider": f"eq.{source}", "provider_user_id": f"eq.{external_id}"},
        )
    else:
        customer = crm_module.sb_post(
            "customers",
            {
                **customer_payload,
                "first_seen_at": now_iso(),
                "tags": ["浏览器采集"],
            },
        )[0]
        customer_id = customer["id"]
        crm_module.sb_post(
            "customer_identities",
            {
                "customer_id": customer_id,
                "provider": source,
                "provider_user_id": external_id,
                "display_name": display_name,
                "raw_profile": raw_profile,
            },
        )
        created = True

    messages_created = 0
    for message in normalized_messages(item, latest_message, captured_at):
        message_id = f"capture_{stable_hash(source, external_id, message['text'], message['sent_at'], message['index'])[:40]}"
        try:
            crm_module.sb_post(
                "messages",
                {
                    "customer_id": customer_id,
                    "provider": source,
                    "provider_message_id": message_id,
                    "direction": message["direction"],
                    "message_type": message["message_type"],
                    "text": message["text"],
                    "raw_event": {**raw_profile, "message": message["raw"]},
                    "sent_at": message["sent_at"],
                },
            )
            messages_created += 1
        except Exception:
            continue

    return {
        "customer_id": customer_id,
        "created": created,
        "message_created": messages_created > 0,
        "messages_created": messages_created,
        "display_name": display_name,
        "source": source,
    }


@app.route("/api/capture/facebook-customer", methods=["POST", "OPTIONS"])
def capture_facebook_customer():
    if request.method == "OPTIONS":
        return cors_response({"ok": True})
    if not capture_authorized():
        return cors_response({"ok": False, "error": "Unauthorized capture request."}, 401)
    if not crm_module.database_ready():
        return cors_response({"ok": False, "error": "Database is not configured."}, 500)

    payload = request.get_json(silent=True) or {}
    raw_items = payload.get("customers") if isinstance(payload.get("customers"), list) else [payload]
    results = []
    errors = []
    for item in raw_items[:50]:
        if not isinstance(item, dict):
            continue
        try:
            results.append(upsert_customer(item))
        except Exception as error:
            errors.append({"display_name": item.get("display_name"), "error": str(error)})
    return cors_response({"ok": not errors, "saved": len(results), "results": results, "errors": errors})
