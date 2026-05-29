"""Runtime fixes and diagnostics for WhatsApp webhook ingestion."""

import hashlib
import hmac
import os

import requests
from flask import Response, abort, jsonify, request

try:
    import app as crm_module
except ImportError:
    import app_live_new as crm_module

app = crm_module.app
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
    def safe_whatsapp_graph(path, params=None):
        try:
            return {"ok": True, "data": whatsapp_live.whatsapp_graph_get(path, params or {})}
        except requests.RequestException as error:
            response = getattr(error, "response", None)
            detail = None
            if response is not None:
                try:
                    detail = response.json()
                except ValueError:
                    detail = response.text[:500]
            return {"ok": False, "error": str(error), "detail": detail}
        except RuntimeError as error:
            return {"ok": False, "error": str(error)}

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
            "graph": {
                "phone_number": safe_whatsapp_graph(
                    whatsapp_live.WHATSAPP_PHONE_NUMBER_ID,
                    {"fields": "id,display_phone_number,verified_name,quality_rating,name_status,platform_type"},
                )
                if whatsapp_live.WHATSAPP_PHONE_NUMBER_ID
                else {"ok": False, "error": "WHATSAPP_PHONE_NUMBER_ID missing"},
                "business_account": safe_whatsapp_graph(
                    whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID,
                    {"fields": "id,name,account_review_status"},
                )
                if whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID
                else {"ok": False, "error": "WHATSAPP_BUSINESS_ACCOUNT_ID missing"},
                "subscribed_apps": safe_whatsapp_graph(f"{whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps")
                if whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID
                else {"ok": False, "error": "WHATSAPP_BUSINESS_ACCOUNT_ID missing"},
                "message_templates": safe_whatsapp_graph(
                    f"{whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID}/message_templates",
                    {"limit": "5"},
                )
                if whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID
                else {"ok": False, "error": "WHATSAPP_BUSINESS_ACCOUNT_ID missing"},
            },
        }
    )


def whatsapp_subscribe_app():
    if not whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID:
        return jsonify({"ok": False, "error": "WHATSAPP_BUSINESS_ACCOUNT_ID is required."}), 400
    try:
        result = whatsapp_live.whatsapp_graph_post(f"{whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps", {})
    except requests.RequestException as error:
        response = getattr(error, "response", None)
        detail = None
        if response is not None:
            try:
                detail = response.json()
            except ValueError:
                detail = response.text[:500]
        return jsonify({"ok": False, "error": str(error), "detail": detail}), 502
    except RuntimeError as error:
        return jsonify({"ok": False, "error": str(error)}), 400
    return jsonify({"ok": True, "result": result})


app.view_functions["receive_whatsapp_webhook"] = receive_whatsapp_webhook_fixed
app.view_functions["verify_whatsapp_webhook"] = verify_whatsapp_webhook_fixed
app.view_functions["receive_webhook"] = receive_meta_webhook_fixed
if "whatsapp_diagnostics" in app.view_functions:
    app.view_functions["whatsapp_diagnostics"] = whatsapp_diagnostics_fixed
else:
    app.add_url_rule("/admin/whatsapp/diagnostics", "whatsapp_diagnostics", whatsapp_diagnostics_fixed, methods=["GET"])
app.add_url_rule("/admin/whatsapp/subscribe-app", "whatsapp_subscribe_app", whatsapp_subscribe_app, methods=["POST"])


@app.post("/admin/backfill/whatsapp-profiles")
def backfill_whatsapp_profiles():
    try:
        identities = crm_module.sb_get_all(
            "customer_identities",
            {
                "provider": "eq.whatsapp",
                "select": "customer_id,provider_user_id,display_name,raw_profile",
            },
            page_size=1000,
            max_rows=50000,
        )
    except requests.RequestException as error:
        return jsonify({"ok": False, "error": str(error)}), 502

    updated = 0
    skipped = 0
    errors = []
    for identity in identities:
        customer_id = identity.get("customer_id")
        wa_id = identity.get("provider_user_id")
        if not customer_id or not wa_id:
            skipped += 1
            continue
        profile = identity.get("raw_profile") or {}
        name = profile.get("name") or identity.get("display_name") or f"WhatsApp {wa_id[-6:]}"
        picture_url = whatsapp_live.whatsapp_profile_picture_url(profile)
        raw_profile = {**profile, "name": name, "wa_id": wa_id}
        if picture_url:
            raw_profile["profile_pic_url"] = picture_url
        else:
            raw_profile.pop("profile_pic_url", None)
        try:
            crm_module.sb_patch(
                "customers",
                {
                    "display_name": name,
                    "profile_pic_url": picture_url,
                    "updated_at": crm_module.now_iso(),
                },
                {"id": f"eq.{customer_id}"},
            )
            crm_module.sb_patch(
                "customer_identities",
                {
                    "display_name": name,
                    "raw_profile": raw_profile,
                    "updated_at": crm_module.now_iso(),
                },
                {"provider": "eq.whatsapp", "provider_user_id": f"eq.{wa_id}"},
            )
            updated += 1
        except requests.RequestException as error:
            errors.append({"wa_id": wa_id, "error": str(error)})

    return jsonify({"ok": True, "checked": len(identities), "updated": updated, "skipped": skipped, "error_count": len(errors), "errors": errors[:20]})
