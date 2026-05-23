"""Runtime fixes and diagnostics for WhatsApp webhook ingestion."""

import hashlib
import hmac
import os

import requests
from flask import Response, abort, jsonify, request

from app_live_new import app, crm_module
import whatsapp_live

WHATSAPP_APP_SECRET = os.getenv("WHATSAPP_APP_SECRET", "")
FALLBACK_VERIFY_TOKEN = "coolfix-whatsapp-verify-2026"


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


def receive_whatsapp_webhook_fixed():
    raw = request.get_data()
    if not verify_whatsapp_signature(raw):
        abort(403)
    payload = request.get_json(force=True, silent=True) or {}
    imported = whatsapp_live.process_whatsapp_payload(payload) if payload.get("object") == "whatsapp_business_account" else 0
    return jsonify({"ok": True, "imported": imported})


def verify_whatsapp_webhook_fixed():
    accepted = {item for item in [whatsapp_live.WHATSAPP_VERIFY_TOKEN, crm_module.META_VERIFY_TOKEN, FALLBACK_VERIFY_TOKEN] if item}
    if request.args.get("hub.mode") == "subscribe" and request.args.get("hub.verify_token") in accepted:
        return Response(request.args.get("hub.challenge") or "", status=200, mimetype="text/plain")
    abort(403)


def receive_meta_webhook_fixed():
    raw = request.get_data()
    payload = request.get_json(force=True, silent=True) or {}
    if payload.get("object") == "whatsapp_business_account":
        if not verify_whatsapp_signature(raw):
            abort(403)
        imported = whatsapp_live.process_whatsapp_payload(payload)
    else:
        if not crm_module.verify_meta_signature(raw):
            abort(403)
        imported = 0
        if payload.get("object") == "page":
            for entry in payload.get("entry", []):
                for event in entry.get("messaging", []):
                    crm_module.process_event(event)
                    imported += 1
    return jsonify({"ok": True, "imported": imported})


def whatsapp_diagnostics_fixed():
    try:
        customers = crm_module.sb_get_all("customers", {"select": "source"}, page_size=1000, max_rows=50000)
        whatsapp_messages = crm_module.sb_get("messages", {"provider": "eq.whatsapp", "select": "id", "limit": "1"})
    except requests.RequestException as error:
        return jsonify({"ok": False, "error": str(error)}), 502

    return jsonify(
        {
            "ok": True,
            "configured": {
                "verify_token_present": bool(whatsapp_live.WHATSAPP_VERIFY_TOKEN),
                "app_secret_present": bool(WHATSAPP_APP_SECRET or crm_module.META_APP_SECRET),
                "dedicated_app_secret_present": bool(WHATSAPP_APP_SECRET),
                "access_token_present": bool(whatsapp_live.WHATSAPP_ACCESS_TOKEN),
                "phone_number_id_present": bool(whatsapp_live.WHATSAPP_PHONE_NUMBER_ID),
                "business_account_id_present": bool(whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID),
            },
            "webhook_urls": {
                "preferred": "https://crm-8t7y.onrender.com/webhooks/whatsapp",
                "compatible": "https://crm-8t7y.onrender.com/webhooks/meta",
            },
            "database": {
                "whatsapp_customers": sum(1 for row in customers if row.get("source") == "whatsapp"),
                "has_whatsapp_messages": bool(whatsapp_messages),
            },
        }
    )


app.view_functions["receive_whatsapp_webhook"] = receive_whatsapp_webhook_fixed
app.view_functions["verify_whatsapp_webhook"] = verify_whatsapp_webhook_fixed
app.view_functions["receive_webhook"] = receive_meta_webhook_fixed
if "whatsapp_diagnostics" in app.view_functions:
    app.view_functions["whatsapp_diagnostics"] = whatsapp_diagnostics_fixed
else:
    app.add_url_rule("/admin/whatsapp/diagnostics", "whatsapp_diagnostics", whatsapp_diagnostics_fixed, methods=["GET"])
