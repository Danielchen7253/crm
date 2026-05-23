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

REQUIRED_META_PERMISSION_ORDER = [
    "pages_messaging",
    "pages_manage_metadata",
    "pages_show_list",
    "pages_read_engagement",
    "Business Asset User Profile Access",
]

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


def graph_get(path, params=None):
    page_access_token = getattr(crm_module, "META_PAGE_ACCESS_TOKEN", "")
    graph_api_version = getattr(crm_module, "GRAPH_API_VERSION", "v21.0")
    if not page_access_token:
        return {"ok": False, "error": "META_PAGE_ACCESS_TOKEN missing"}

    request_params = dict(params or {})
    request_params["access_token"] = page_access_token
    try:
        response = requests.get(
            f"https://graph.facebook.com/{graph_api_version}/{path.lstrip('/')}",
            params=request_params,
            timeout=20,
        )
        response.raise_for_status()
        return {"ok": True, "data": response.json()}
    except requests.RequestException as error:
        return {"ok": False, "error": redacted_error(error)}


def summarize_graph_result(result):
    if result.get("ok"):
        data = result.get("data") or {}
        rows = data.get("data") if isinstance(data, dict) else None
        return {
            "ok": True,
            "count_returned": len(rows) if isinstance(rows, list) else None,
            "has_next_page": bool(data.get("paging", {}).get("next")) if isinstance(data, dict) else None,
        }
    return {"ok": False, "error": result.get("error")}


def run_capability_checks(scopes):
    page_id = getattr(crm_module, "META_PAGE_ID", "")
    checks = {}

    if not page_id:
        missing_page = {"ok": False, "error": "META_PAGE_ID missing"}
        return {name: missing_page for name in REQUIRED_META_PERMISSION_ORDER}

    conversations = graph_get(
        f"{page_id}/conversations",
        {"fields": "id,updated_time,participants{id,name,profile_pic}", "limit": "5"},
    )
    checks["pages_messaging"] = {
        **summarize_graph_result(conversations),
        "purpose": CORE_META_PERMISSIONS["pages_messaging"],
        "tested_by": f"GET /{page_id}/conversations",
    }

    subscribed_apps = graph_get(f"{page_id}/subscribed_apps", {"fields": "id,name"})
    checks["pages_manage_metadata"] = {
        **summarize_graph_result(subscribed_apps),
        "purpose": CORE_META_PERMISSIONS["pages_manage_metadata"],
        "tested_by": f"GET /{page_id}/subscribed_apps",
    }

    page_profile = graph_get(page_id, {"fields": "id,name,category,link,picture"})
    checks["pages_read_engagement"] = {
        **summarize_graph_result(page_profile),
        "purpose": CORE_META_PERMISSIONS["pages_read_engagement"],
        "tested_by": f"GET /{page_id}?fields=id,name,category,link,picture",
    }

    checks["pages_show_list"] = {
        "ok": "pages_show_list" in scopes,
        "purpose": CORE_META_PERMISSIONS["pages_show_list"],
        "tested_by": "token scope check; /me/accounts needs a user token, not the Page token stored in Render",
        "note": "Use this permission when generating the Page access token from the same Meta app.",
    }

    profile_ok = False
    profile_count = None
    profile_error = None
    if conversations.get("ok"):
        rows = (conversations.get("data") or {}).get("data") or []
        profile_count = len(rows)
        for conversation in rows:
            participants = ((conversation.get("participants") or {}).get("data")) or []
            if any(person.get("name") or person.get("profile_pic") or person.get("picture") for person in participants):
                profile_ok = True
                break
    else:
        profile_error = conversations.get("error")
    checks["Business Asset User Profile Access"] = {
        "ok": profile_ok,
        "count_returned": profile_count,
        "error": profile_error,
        "purpose": CORE_META_PERMISSIONS["Business Asset User Profile Access"],
        "tested_by": f"GET /{page_id}/conversations?fields=participants{{id,name,profile_pic}}",
        "note": "This is the permission/feature that helps CRM store real customer names and avatars.",
    }

    return checks


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
    capability_checks = run_capability_checks(scopes)

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
            "required_permissions": [
                {
                    "name": name,
                    "scope_present": name in scopes,
                    "capability_ok": capability_checks.get(name, {}).get("ok"),
                    "purpose": CORE_META_PERMISSIONS[name],
                }
                for name in REQUIRED_META_PERMISSION_ORDER
            ],
            "core_permissions": core_status,
            "capability_checks": capability_checks,
            "useful_later_permissions": USEFUL_LATER_PERMISSIONS,
            "not_needed_now": NOT_NEEDED_NOW,
        }
    )


@app.get("/admin/meta/permission-checks")
def meta_permission_checks():
    try:
        token_debug = debug_page_token()
    except requests.RequestException as error:
        token_debug = {"ok": False, "error": redacted_error(error)}

    scopes = set()
    if token_debug.get("ok"):
        scopes = set(token_debug.get("data", {}).get("scopes") or [])

    checks = run_capability_checks(scopes)
    return jsonify(
        {
            "ok": True,
            "token_debug_ok": token_debug.get("ok", False),
            "token_error": token_debug.get("error"),
            "checks": checks,
            "ready": all(checks.get(name, {}).get("ok") for name in REQUIRED_META_PERMISSION_ORDER),
        }
    )
