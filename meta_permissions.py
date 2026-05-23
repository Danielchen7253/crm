"""Meta permission tracking and diagnostics for the CRM."""

import os

import requests
from flask import jsonify

try:
    import app as crm_module
except ImportError:
    import app_live_new as crm_module

app = crm_module.app

META_APP_ID = os.getenv("META_APP_ID", "1528469058632372")

CORE_META_PERMISSIONS = {
    "pages_messaging": "Send/receive Page Messenger conversations for CRM chat.",
    "pages_manage_metadata": "Subscribe Page webhooks and manage Page webhook settings.",
    "pages_show_list": "Let the app list and connect managed Facebook Pages.",
    "pages_read_engagement": "Read Page metadata and engagement needed for diagnostics and customer context.",
    "Business Asset User Profile Access": "Read profile fields for users interacting with business assets, such as name and picture.",
}

USEFUL_LATER_PERMISSIONS = {
    "pages_read_user_content": "Read Page visitor posts, comments, ratings, and other Page user-generated content.",
    "pages_manage_engagement": "Manage Page comments and engagement from CRM later.",
    "read_insights": "Read Page/app performance metrics for reports.",
    "business_management": "Manage business assets such as WABA, system users, and business settings.",
}

NOT_NEEDED_NOW = {
    "Live Video API": "For live video management, not CRM customer inbox.",
    "email": "Reads the logged-in user's email; not needed for customer sync.",
    "facebook_branded_content_ads_brand": "Partnership ads/brand collaboration feature, not customer inbox.",
    "facebook_creator_marketplace_discovery": "Creator Marketplace discovery, not Facebook Marketplace buyer chats.",
    "pages_manage_posts": "Create/edit/delete Page posts; not needed for message import.",
    "public_profile": "Default login profile permission; not useful for Page customer sync by itself.",
}


def debug_page_token():
    page_access_token = getattr(crm_module, "META_PAGE_ACCESS_TOKEN", "")
    app_secret = getattr(crm_module, "META_APP_SECRET", "") or os.getenv("WHATSAPP_APP_SECRET", "")
    graph_api_version = getattr(crm_module, "GRAPH_API_VERSION", "v21.0")

    if not page_access_token:
        return {"ok": False, "error": "META_PAGE_ACCESS_TOKEN missing"}
    if not app_secret:
        return {"ok": False, "error": "META_APP_SECRET missing"}

    response = requests.get(
        f"https://graph.facebook.com/{graph_api_version}/debug_token",
        params={
            "input_token": page_access_token,
            "access_token": f"{META_APP_ID}|{app_secret}",
        },
        timeout=20,
    )
    response.raise_for_status()
    return {"ok": True, "data": response.json().get("data", {})}


def redacted_error(error):
    response = getattr(error, "response", None)
    if response is not None:
        try:
            payload = response.json()
            meta_error = payload.get("error", {}) if isinstance(payload, dict) else {}
            message = meta_error.get("message")
            code = meta_error.get("code")
            if message:
                return f"Meta API error {code}: {message}" if code else f"Meta API error: {message}"
        except ValueError:
            pass
        return f"Meta API request failed with HTTP {response.status_code}"

    text = str(error)
    secrets = [
        getattr(crm_module, "META_PAGE_ACCESS_TOKEN", ""),
        getattr(crm_module, "META_APP_SECRET", ""),
        os.getenv("WHATSAPP_APP_SECRET", ""),
    ]
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[redacted]")
    if " for url:" in text:
        text = text.split(" for url:", 1)[0]
    return text


@app.get("/admin/meta/permissions")
def meta_permissions():
    try:
        token_debug = debug_page_token()
    except requests.RequestException as error:
        token_debug = {"ok": False, "error": redacted_error(error)}

    scopes = set()
    if token_debug.get("ok"):
        scopes = set(token_debug.get("data", {}).get("scopes") or [])

    core_status = {
        name: {
            "present": name in scopes,
            "purpose": purpose,
        }
        for name, purpose in CORE_META_PERMISSIONS.items()
    }

    return jsonify(
        {
            "ok": True,
            "app_id": META_APP_ID,
            "token_debug_ok": token_debug.get("ok", False),
            "token": {
                "app_id": (token_debug.get("data") or {}).get("app_id"),
                "type": (token_debug.get("data") or {}).get("type"),
                "expires_at": (token_debug.get("data") or {}).get("expires_at"),
                "is_valid": (token_debug.get("data") or {}).get("is_valid"),
                "scopes": sorted(scopes),
                "error": token_debug.get("error"),
            },
            "core_permissions": core_status,
            "useful_later_permissions": USEFUL_LATER_PERMISSIONS,
            "not_needed_now": NOT_NEEDED_NOW,
        }
    )
