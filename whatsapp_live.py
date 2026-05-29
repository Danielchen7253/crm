"""WhatsApp Business Cloud API integration for the live CRM."""

import os
import hashlib
import hmac
from datetime import datetime, timezone

import requests
from flask import Response, abort, jsonify, redirect, request

from app_live_new import app, crm_module

WHATSAPP_VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN", os.getenv("META_VERIFY_TOKEN", ""))
WHATSAPP_FALLBACK_VERIFY_TOKEN = "coolfix-whatsapp-verify-2026"
WHATSAPP_APP_SECRET = os.getenv("WHATSAPP_APP_SECRET", "")
WHATSAPP_ACCESS_TOKEN = os.getenv("WHATSAPP_ACCESS_TOKEN", "")
WHATSAPP_PHONE_NUMBER_ID = os.getenv("WHATSAPP_PHONE_NUMBER_ID", "")
WHATSAPP_BUSINESS_ACCOUNT_ID = os.getenv("WHATSAPP_BUSINESS_ACCOUNT_ID", "")
WHATSAPP_DEFAULT_AVATAR_URL = "https://upload.wikimedia.org/wikipedia/commons/5/5e/WhatsApp_icon.png"


def whatsapp_headers(content_type=True):
    headers = {"Authorization": f"Bearer {WHATSAPP_ACCESS_TOKEN}"}
    if content_type:
        headers["Content-Type"] = "application/json"
    return headers


def whatsapp_graph_get(path, params=None):
    response = requests.get(
        f"https://graph.facebook.com/{crm_module.GRAPH_API_VERSION}/{path.lstrip('/')}",
        headers=whatsapp_headers(content_type=False),
        params=params or {},
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def whatsapp_graph_post(path, payload):
    if not WHATSAPP_ACCESS_TOKEN:
        raise RuntimeError("WHATSAPP_ACCESS_TOKEN is required.")
    response = requests.post(
        f"https://graph.facebook.com/{crm_module.GRAPH_API_VERSION}/{path.lstrip('/')}",
        headers=whatsapp_headers(),
        json=payload,
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


def verify_signature_with_secrets(raw_body, *secrets):
    active_secrets = [secret for secret in secrets if secret]
    if not active_secrets:
        return True
    signature = request.headers.get("X-Hub-Signature-256", "")
    if not signature.startswith("sha256="):
        return False
    for secret in active_secrets:
        expected = hmac.new(secret.encode("utf-8"), raw_body, hashlib.sha256).hexdigest()
        if hmac.compare_digest(signature, f"sha256={expected}"):
            return True
    return False


def verify_whatsapp_signature(raw_body):
    return verify_signature_with_secrets(raw_body, WHATSAPP_APP_SECRET, crm_module.META_APP_SECRET)


def find_provider_identity(provider, provider_user_id):
    rows = crm_module.sb_get(
        "customer_identities",
        {
            "provider": f"eq.{provider}",
            "provider_user_id": f"eq.{provider_user_id}",
            "select": "customer_id",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


def find_customer_identity(customer_id):
    rows = crm_module.sb_get(
        "customer_identities",
        {
            "customer_id": f"eq.{customer_id}",
            "select": "provider,provider_user_id,display_name",
            "limit": "10",
        },
    )
    if not rows:
        return None
    source_rows = crm_module.sb_get("customers", {"id": f"eq.{customer_id}", "select": "source", "limit": "1"})
    source = source_rows[0].get("source") if source_rows else None
    return next((row for row in rows if row.get("provider") == source), rows[0])


def whatsapp_profile_picture_url(profile):
    if not isinstance(profile, dict):
        return None
    for key in ["profile_pic_url", "profile_pic", "picture_url", "avatar_url"]:
        value = profile.get(key)
        if isinstance(value, str) and value.startswith("http"):
            return value
    picture = profile.get("picture")
    if isinstance(picture, str) and picture.startswith("http"):
        return picture
    if isinstance(picture, dict):
        data = picture.get("data")
        if isinstance(data, dict) and isinstance(data.get("url"), str):
            return data["url"]
        if isinstance(picture.get("url"), str):
            return picture["url"]
    return None


def ensure_whatsapp_customer(wa_id, profile, metadata):
    name = profile.get("name") or f"WhatsApp {wa_id[-6:]}"
    identity = find_provider_identity("whatsapp", wa_id)
    profile_pic_url = whatsapp_profile_picture_url(profile) or WHATSAPP_DEFAULT_AVATAR_URL
    profile_payload = {"display_name": name, "profile_pic_url": profile_pic_url, "updated_at": crm_module.now_iso()}
    if identity:
        customer_id = identity["customer_id"]
        crm_module.sb_patch(
            "customers",
            {**profile_payload, "last_seen_at": crm_module.now_iso()},
            {"id": f"eq.{customer_id}"},
        )
        crm_module.sb_patch(
            "customer_identities",
            {"display_name": name, "raw_profile": profile, "updated_at": crm_module.now_iso()},
            {"provider": "eq.whatsapp", "provider_user_id": f"eq.{wa_id}"},
        )
        return customer_id, False

    customer = crm_module.sb_post(
        "customers",
        {
            **profile_payload,
            "source": "whatsapp",
            "first_seen_at": crm_module.now_iso(),
            "last_seen_at": crm_module.now_iso(),
            "metadata": metadata,
        },
    )[0]
    crm_module.sb_post(
        "customer_identities",
        {
            "customer_id": customer["id"],
            "provider": "whatsapp",
            "provider_user_id": wa_id,
            "display_name": name,
            "raw_profile": profile,
        },
    )
    return customer["id"], True


def save_whatsapp_message(customer_id, message_id, direction, text, attachments, raw, sent_at=None):
    if message_id:
        existing = crm_module.sb_get(
            "messages",
            {"provider": "eq.whatsapp", "provider_message_id": f"eq.{message_id}", "select": "id", "limit": "1"},
        )
        if existing:
            return False
    sent_at = sent_at or crm_module.now_iso()
    crm_module.sb_post(
        "messages",
        {
            "customer_id": customer_id,
            "provider": "whatsapp",
            "provider_message_id": message_id,
            "direction": direction,
            "message_type": "attachment" if attachments else "text",
            "text": text,
            "attachments": attachments or [],
            "raw_event": raw,
            "sent_at": sent_at,
        },
    )
    crm_module.sb_patch(
        "customers",
        {"last_seen_at": crm_module.now_iso(), "last_message_at": sent_at, "updated_at": crm_module.now_iso()},
        {"id": f"eq.{customer_id}"},
    )
    return True


def contact_profile(value, wa_id):
    contacts = value.get("contacts") or []
    contact = next((item for item in contacts if item.get("wa_id") == wa_id), {})
    profile = contact.get("profile") or {}
    return {**profile, "name": profile.get("name") or wa_id, "wa_id": wa_id}


def message_text(message):
    message_type = message.get("type")
    if message_type == "text":
        return (message.get("text") or {}).get("body")
    return (message.get(message_type) or {}).get("caption")


def message_attachments(message):
    message_type = message.get("type")
    if message_type not in {"image", "audio", "video", "document", "sticker"}:
        return []
    media = message.get(message_type) or {}
    media_id = media.get("id")
    if not media_id:
        return []
    return [
        {
            "type": "file" if message_type == "document" else message_type,
            "url": f"/media/whatsapp/{media_id}",
            "mime_type": media.get("mime_type"),
            "filename": media.get("filename"),
            "media_id": media_id,
        }
    ]


def message_sent_at(message):
    timestamp = message.get("timestamp")
    return datetime.fromtimestamp(int(timestamp), tz=timezone.utc).isoformat() if timestamp else None


def process_whatsapp_payload(payload):
    imported = 0
    for entry in payload.get("entry", []):
        for change in entry.get("changes", []):
            value = change.get("value") or {}
            for message in value.get("messages", []):
                wa_id = message.get("from")
                if not wa_id:
                    continue
                metadata = {
                    "whatsapp_wa_id": wa_id,
                    "whatsapp_phone_number_id": (value.get("metadata") or {}).get("phone_number_id"),
                    "whatsapp_business_account_id": entry.get("id") or WHATSAPP_BUSINESS_ACCOUNT_ID,
                }
                customer_id, _ = ensure_whatsapp_customer(wa_id, contact_profile(value, wa_id), metadata)
                if save_whatsapp_message(
                    customer_id,
                    message.get("id"),
                    "inbound",
                    message_text(message),
                    message_attachments(message),
                    {"entry": entry, "change": change, "message": message},
                    message_sent_at(message),
                ):
                    imported += 1
    return imported


@app.get("/webhooks/whatsapp")
def verify_whatsapp_webhook():
    accepted_tokens = {item for item in [WHATSAPP_VERIFY_TOKEN, crm_module.META_VERIFY_TOKEN, WHATSAPP_FALLBACK_VERIFY_TOKEN] if item}
    if request.args.get("hub.mode") == "subscribe" and request.args.get("hub.verify_token") in accepted_tokens:
        return Response(request.args.get("hub.challenge") or "", status=200, mimetype="text/plain")
    abort(403)


@app.post("/webhooks/whatsapp")
def receive_whatsapp_webhook():
    raw = request.get_data()
    if not verify_whatsapp_signature(raw):
        abort(403)
    payload = request.get_json(force=True, silent=True) or {}
    imported = process_whatsapp_payload(payload) if payload.get("object") == "whatsapp_business_account" else 0
    return jsonify({"ok": True, "imported": imported})


@app.get("/media/whatsapp/<media_id>")
def proxy_whatsapp_media(media_id):
    if not WHATSAPP_ACCESS_TOKEN:
        abort(404)
    try:
        meta = whatsapp_graph_get(media_id)
        media_url = meta.get("url")
        if not media_url:
            abort(404)
        media_response = requests.get(
            media_url,
            headers=whatsapp_headers(content_type=False),
            timeout=30,
        )
        media_response.raise_for_status()
    except requests.RequestException:
        abort(404)
    response = Response(media_response.content, mimetype=media_response.headers.get("Content-Type") or meta.get("mime_type"))
    response.headers["Cache-Control"] = "private, max-age=300"
    return response


def live_verify_meta_webhook():
    token = request.args.get("hub.verify_token")
    accepted = {item for item in [crm_module.META_VERIFY_TOKEN, WHATSAPP_VERIFY_TOKEN, WHATSAPP_FALLBACK_VERIFY_TOKEN] if item}
    if request.args.get("hub.mode") == "subscribe" and token in accepted:
        return Response(request.args.get("hub.challenge") or "", status=200, mimetype="text/plain")
    abort(403)


def live_receive_meta_webhook():
    raw = request.get_data()
    payload = request.get_json(force=True, silent=True) or {}
    if payload.get("object") == "whatsapp_business_account":
        if not verify_whatsapp_signature(raw):
            abort(403)
    elif not crm_module.verify_meta_signature(raw):
        abort(403)
    imported = 0
    if payload.get("object") == "page":
        for entry in payload.get("entry", []):
            for event in entry.get("messaging", []):
                crm_module.process_event(event)
                imported += 1
    elif payload.get("object") == "whatsapp_business_account":
        imported = process_whatsapp_payload(payload)
    return jsonify({"ok": True, "imported": imported})


def live_send_customer_message(customer_id):
    text = request.form.get("text", "").strip()
    ai_draft_id = request.form.get("ai_draft_id", "").strip()
    identity = find_customer_identity(customer_id)
    wants_json = request.headers.get("X-Requested-With") == "fetch" or "application/json" in request.headers.get("Accept", "")
    sent_at = crm_module.now_iso()
    if not text:
        if wants_json:
            return jsonify({"ok": False, "error": "Message text is required."}), 400
        return redirect(f"/?customer={customer_id}", code=303)
    if not identity:
        if wants_json:
            return jsonify({"ok": False, "error": "Customer messaging identity was not found."}), 400
        return redirect(f"/?customer={customer_id}", code=303)
    if text and identity:
        if identity.get("provider") == "whatsapp":
            if not WHATSAPP_PHONE_NUMBER_ID:
                return jsonify({"ok": False, "error": "WHATSAPP_PHONE_NUMBER_ID is required."}), 400
            result = whatsapp_graph_post(
                f"{WHATSAPP_PHONE_NUMBER_ID}/messages",
                {"messaging_product": "whatsapp", "to": identity["provider_user_id"], "type": "text", "text": {"body": text}},
            )
            message_id = ((result.get("messages") or [{}])[0]).get("id")
            save_whatsapp_message(customer_id, message_id, "outbound", text, [], result, sent_at)
        else:
            result = crm_module.graph_post(
                "me/messages",
                {"recipient": {"id": identity["provider_user_id"]}, "messaging_type": "RESPONSE", "message": {"text": text}},
            )
            message_id = result.get("message_id")
            crm_module.save_message(customer_id, message_id, "outbound", text, [], result, sent_at)
        if ai_draft_id:
            crm_module.sb_patch(
                "ai_reply_drafts",
                {"final_text": text, "status": "sent", "updated_at": crm_module.now_iso()},
                {"id": f"eq.{ai_draft_id}"},
            )
        if wants_json:
            return jsonify({"ok": True, "message": {"direction": "outbound", "text": text, "sent_at": sent_at, "provider_message_id": message_id}})
    return redirect(f"/?customer={customer_id}", code=303)


app.view_functions["verify_webhook"] = live_verify_meta_webhook
app.view_functions["receive_webhook"] = live_receive_meta_webhook
app.view_functions["send_customer_message"] = live_send_customer_message


@app.get("/admin/whatsapp/diagnostics")
def whatsapp_diagnostics():
    try:
        source_counts = crm_module.sb_get("customers", {"select": "source"})
        whatsapp_customers = sum(1 for row in source_counts if row.get("source") == "whatsapp")
        whatsapp_messages = crm_module.sb_get(
            "messages",
            {"provider": "eq.whatsapp", "select": "id", "limit": "1"},
        )
    except requests.RequestException as error:
        return jsonify({"ok": False, "error": str(error)}), 502

    return jsonify(
        {
            "ok": True,
            "configured": {
                "verify_token_present": bool(WHATSAPP_VERIFY_TOKEN),
                "app_secret_present": bool(WHATSAPP_APP_SECRET or crm_module.META_APP_SECRET),
                "dedicated_app_secret_present": bool(WHATSAPP_APP_SECRET),
                "access_token_present": bool(WHATSAPP_ACCESS_TOKEN),
                "phone_number_id_present": bool(WHATSAPP_PHONE_NUMBER_ID),
                "business_account_id_present": bool(WHATSAPP_BUSINESS_ACCOUNT_ID),
            },
            "webhook_urls": {
                "preferred": "https://crm-8t7y.onrender.com/webhooks/whatsapp",
                "compatible": "https://crm-8t7y.onrender.com/webhooks/meta",
            },
            "database": {
                "whatsapp_customers": whatsapp_customers,
                "has_whatsapp_messages": bool(whatsapp_messages),
            },
        }
    )
