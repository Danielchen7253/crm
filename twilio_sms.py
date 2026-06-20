"""Twilio SMS/MMS integration for CRM customer intake and replies."""

import base64
import hashlib
import hmac
import os
from urllib.parse import urlparse, urlunparse

import requests
from flask import Response, jsonify, redirect, request

from app_live_new import app, crm_module

TWILIO_ACCOUNT_SID = os.getenv("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.getenv("TWILIO_AUTH_TOKEN", "")
TWILIO_FROM_NUMBER = os.getenv("TWILIO_FROM_NUMBER", "+18587570488")
TWILIO_PROVIDER = "twilio_sms"
TWILIO_SOURCE = "sms"

previous_send_customer_message = app.view_functions.get("send_customer_message")


def normalize_phone(value):
    digits = "".join(ch for ch in (value or "") if ch.isdigit())
    if not digits:
        return ""
    if len(digits) == 10:
        digits = "1" + digits
    return f"+{digits}"


def twilio_signature_base_url():
    parsed = urlparse(request.url)
    scheme = request.headers.get("X-Forwarded-Proto", parsed.scheme or "https")
    host = request.headers.get("X-Forwarded-Host", request.host)
    return urlunparse((scheme, host, parsed.path, "", parsed.query, ""))


def verify_twilio_signature():
    if not TWILIO_AUTH_TOKEN:
        return True
    signature = request.headers.get("X-Twilio-Signature", "")
    if not signature:
        return False
    payload = twilio_signature_base_url()
    for key in sorted(request.form):
        payload += key + request.form.get(key, "")
    digest = hmac.new(TWILIO_AUTH_TOKEN.encode("utf-8"), payload.encode("utf-8"), hashlib.sha1).digest()
    expected = base64.b64encode(digest).decode("ascii")
    return hmac.compare_digest(signature, expected)


def twilio_auth():
    if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
        raise RuntimeError("TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN are required.")
    return (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)


def find_twilio_identity(phone):
    rows = crm_module.sb_get(
        "customer_identities",
        {
            "provider": f"eq.{TWILIO_PROVIDER}",
            "provider_user_id": f"eq.{phone}",
            "select": "customer_id",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


def load_customer(customer_id):
    rows = crm_module.sb_get(
        "customers",
        {"id": f"eq.{customer_id}", "select": "id,display_name,metadata,source", "limit": "1"},
    )
    return rows[0] if rows else None


def phone_from_customer(customer):
    metadata = customer.get("metadata") or {}
    if isinstance(metadata, dict):
        return normalize_phone(metadata.get("phone") or metadata.get("sms_phone"))
    return ""


def ensure_twilio_identity(customer_id, phone, display_name=None, raw_profile=None):
    existing = find_twilio_identity(phone)
    if existing:
        return existing["customer_id"]
    crm_module.sb_post(
        "customer_identities",
        {
            "customer_id": customer_id,
            "provider": TWILIO_PROVIDER,
            "provider_user_id": phone,
            "display_name": display_name or phone,
            "raw_profile": raw_profile or {"phone": phone},
        },
    )
    return customer_id


def ensure_sms_customer(phone, raw_profile=None):
    identity = find_twilio_identity(phone)
    now = crm_module.now_iso()
    if identity:
        crm_module.sb_patch(
            "customers",
            {"last_seen_at": now, "updated_at": now},
            {"id": f"eq.{identity['customer_id']}"},
        )
        return identity["customer_id"], False

    display_name = f"SMS {phone}"
    metadata = {"phone": phone, "sms_phone": phone, "twilio": raw_profile or {}}
    customer = crm_module.sb_post(
        "customers",
        {
            "display_name": display_name,
            "source": TWILIO_SOURCE,
            "first_seen_at": now,
            "last_seen_at": now,
            "metadata": metadata,
        },
    )[0]
    ensure_twilio_identity(customer["id"], phone, display_name, raw_profile or metadata)
    return customer["id"], True


def save_twilio_message(customer_id, message_sid, direction, text, attachments, raw, sent_at=None):
    if message_sid:
        existing = crm_module.sb_get(
            "messages",
            {
                "provider": f"eq.{TWILIO_PROVIDER}",
                "provider_message_id": f"eq.{message_sid}",
                "select": "id",
                "limit": "1",
            },
        )
        if existing:
            return False
    sent_at = sent_at or crm_module.now_iso()
    crm_module.sb_post(
        "messages",
        {
            "customer_id": customer_id,
            "provider": TWILIO_PROVIDER,
            "provider_message_id": message_sid,
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


def media_attachments_from_request():
    attachments = []
    try:
        count = int(request.form.get("NumMedia", "0") or "0")
    except ValueError:
        count = 0
    for index in range(count):
        url = request.form.get(f"MediaUrl{index}")
        mime_type = request.form.get(f"MediaContentType{index}") or ""
        if not url:
            continue
        if mime_type.startswith("image/"):
            kind = "image"
        elif mime_type.startswith("audio/"):
            kind = "audio"
        elif mime_type.startswith("video/"):
            kind = "video"
        else:
            kind = "file"
        attachments.append({"type": kind, "url": url, "mime_type": mime_type})
    return attachments


def send_twilio_sms(to_phone, text):
    response = requests.post(
        f"https://api.twilio.com/2010-04-01/Accounts/{TWILIO_ACCOUNT_SID}/Messages.json",
        auth=twilio_auth(),
        data={
            "From": TWILIO_FROM_NUMBER,
            "To": to_phone,
            "Body": text,
            "StatusCallback": "https://crm-8t7y.onrender.com/webhooks/twilio/status",
        },
        timeout=20,
    )
    response.raise_for_status()
    return response.json()


@app.post("/webhooks/twilio/sms")
def receive_twilio_sms():
    if not verify_twilio_signature():
        return Response("Forbidden", status=403, mimetype="text/plain")
    from_phone = normalize_phone(request.form.get("From"))
    if not from_phone:
        return Response("", status=200, mimetype="text/xml")
    customer_id, _ = ensure_sms_customer(from_phone, dict(request.form))
    save_twilio_message(
        customer_id,
        request.form.get("MessageSid") or request.form.get("SmsSid"),
        "inbound",
        request.form.get("Body", ""),
        media_attachments_from_request(),
        dict(request.form),
    )
    return Response("<Response></Response>", status=200, mimetype="text/xml")


@app.post("/webhooks/twilio/status")
def receive_twilio_status():
    return jsonify({"ok": True})


@app.get("/admin/twilio/diagnostics")
def twilio_diagnostics():
    customers = crm_module.sb_get("customers", {"source": f"eq.{TWILIO_SOURCE}", "select": "id", "limit": "1000"})
    messages = crm_module.sb_get("messages", {"provider": f"eq.{TWILIO_PROVIDER}", "select": "id", "limit": "1000"})
    return jsonify(
        {
            "ok": True,
            "from_number": TWILIO_FROM_NUMBER,
            "has_account_sid": bool(TWILIO_ACCOUNT_SID),
            "has_auth_token": bool(TWILIO_AUTH_TOKEN),
            "sms_customers": len(customers),
            "sms_messages": len(messages),
            "webhook_url": "https://crm-8t7y.onrender.com/webhooks/twilio/sms",
        }
    )


def find_twilio_identity_for_customer(customer_id):
    rows = crm_module.sb_get(
        "customer_identities",
        {
            "customer_id": f"eq.{customer_id}",
            "provider": f"eq.{TWILIO_PROVIDER}",
            "select": "provider_user_id",
            "limit": "1",
        },
    )
    if rows:
        return rows[0]
    customer = load_customer(customer_id)
    if not customer:
        return None
    phone = phone_from_customer(customer)
    if not phone:
        return None
    ensure_twilio_identity(customer_id, phone, customer.get("display_name"), customer.get("metadata") or {})
    return {"provider_user_id": phone}


def live_send_customer_message_with_sms(customer_id):
    text = request.form.get("text", "").strip()
    ai_draft_id = request.form.get("ai_draft_id", "").strip()
    wants_json = request.headers.get("X-Requested-With") == "fetch" or "application/json" in request.headers.get("Accept", "")
    sms_identity = find_twilio_identity_for_customer(customer_id)
    if not sms_identity:
        return previous_send_customer_message(customer_id)
    if not text:
        if wants_json:
            return jsonify({"ok": False, "error": "Message text is required."}), 400
        return redirect(f"/?customer={customer_id}", code=303)
    try:
        result = send_twilio_sms(sms_identity["provider_user_id"], text)
    except Exception as error:
        if wants_json:
            return jsonify({"ok": False, "error": str(error)}), 400
        raise
    sent_at = crm_module.now_iso()
    message_sid = result.get("sid")
    save_twilio_message(customer_id, message_sid, "outbound", text, [], result, sent_at)
    if ai_draft_id:
        crm_module.sb_patch(
            "ai_reply_drafts",
            {"final_text": text, "status": "sent", "updated_at": crm_module.now_iso()},
            {"id": f"eq.{ai_draft_id}"},
        )
    if wants_json:
        return jsonify({"ok": True, "message": {"direction": "outbound", "text": text, "sent_at": sent_at, "provider_message_id": message_sid}})
    return redirect(f"/?customer={customer_id}", code=303)


app.view_functions["send_customer_message"] = live_send_customer_message_with_sms
