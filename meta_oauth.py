"""Meta Page OAuth reconnect flow for fixing mismatched Page tokens."""

import secrets
from urllib.parse import urlencode

import requests
from flask import jsonify, redirect, render_template_string, request, session

import app_live_new

app = app_live_new.app
crm_module = app_live_new.crm_module

META_CONNECT_SCOPES = [
    "pages_show_list",
    "pages_messaging",
    "pages_manage_metadata",
    "pages_read_engagement",
]


def public_base_url():
    return request.url_root.rstrip("/")


def callback_url():
    return f"{public_base_url()}/admin/meta/oauth/callback"


def graph_get_with_token(path, token, params=None):
    payload = dict(params or {})
    payload["access_token"] = token
    response = requests.get(
        f"https://graph.facebook.com/{crm_module.GRAPH_API_VERSION}/{path.lstrip('/')}",
        params=payload,
        timeout=25,
    )
    response.raise_for_status()
    return response.json()


def save_setting(key, value, metadata=None):
    row = {
        "provider": "meta",
        "key": key,
        "value": value,
        "metadata": metadata or {},
        "updated_at": crm_module.now_iso(),
    }
    response = requests.post(
        f"{crm_module.SUPABASE_URL}/rest/v1/integration_settings",
        headers={
            **crm_module.sb_headers("resolution=merge-duplicates,return=representation"),
        },
        json=row,
        timeout=20,
    )
    response.raise_for_status()
    crm_module.META_CONFIG_CACHE["loaded_at"] = None
    return response.json()


def exchange_code_for_user_token(code):
    response = requests.get(
        f"https://graph.facebook.com/{crm_module.GRAPH_API_VERSION}/oauth/access_token",
        params={
            "client_id": crm_module.META_APP_ID,
            "client_secret": crm_module.current_meta_app_secret(),
            "redirect_uri": callback_url(),
            "code": code,
        },
        timeout=25,
    )
    response.raise_for_status()
    short_lived = response.json().get("access_token")
    if not short_lived:
        raise RuntimeError("Meta did not return a user access token.")
    exchange = requests.get(
        f"https://graph.facebook.com/{crm_module.GRAPH_API_VERSION}/oauth/access_token",
        params={
            "grant_type": "fb_exchange_token",
            "client_id": crm_module.META_APP_ID,
            "client_secret": crm_module.current_meta_app_secret(),
            "fb_exchange_token": short_lived,
        },
        timeout=25,
    )
    exchange.raise_for_status()
    return exchange.json().get("access_token") or short_lived


def save_first_page(user_token):
    accounts = graph_get_with_token(
        "me/accounts",
        user_token,
        {"fields": "id,name,access_token,tasks,picture", "limit": "100"},
    ).get("data") or []
    if not accounts:
        raise RuntimeError("This Meta user token returned no managed Pages.")
    preferred_id = crm_module.META_PAGE_ID or crm_module.current_meta_page_id()
    selected = next((page for page in accounts if page.get("id") == preferred_id), accounts[0])
    page_id = selected.get("id")
    page_token = selected.get("access_token")
    if not page_id or not page_token:
        raise RuntimeError("Meta did not return a Page access token.")
    save_setting("page_id", page_id, {"page_name": selected.get("name")})
    save_setting("page_access_token", page_token, {"page_name": selected.get("name"), "source": "oauth_reconnect"})
    save_setting("user_access_token", user_token, {"source": "oauth_reconnect"})
    return selected, accounts


@app.get("/admin/meta/reconnect")
def meta_reconnect():
    if not crm_module.current_meta_app_secret():
        return jsonify({"ok": False, "error": "META_APP_SECRET or WHATSAPP_APP_SECRET is required."}), 400
    state = secrets.token_urlsafe(24)
    session["meta_oauth_state"] = state
    url = "https://www.facebook.com/{}/dialog/oauth?{}".format(
        crm_module.GRAPH_API_VERSION,
        urlencode(
            {
                "client_id": crm_module.META_APP_ID,
                "redirect_uri": callback_url(),
                "state": state,
                "scope": ",".join(META_CONNECT_SCOPES),
                "response_type": "code",
            }
        ),
    )
    return redirect(url, code=303)


@app.get("/admin/meta/oauth/callback")
def meta_oauth_callback():
    if request.args.get("error"):
        return jsonify({"ok": False, "error": request.args.get("error_description") or request.args.get("error")}), 400
    if request.args.get("state") != session.get("meta_oauth_state"):
        return jsonify({"ok": False, "error": "Invalid OAuth state."}), 400
    code = request.args.get("code")
    if not code:
        return jsonify({"ok": False, "error": "Missing OAuth code."}), 400
    try:
        user_token = exchange_code_for_user_token(code)
        selected, accounts = save_first_page(user_token)
    except Exception as error:
        return jsonify({"ok": False, "error": str(error)}), 502
    return render_template_string(
        """
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Meta 重新授权完成</title><style>:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}body{margin:0;padding:24px}.card{max-width:680px;margin:0 auto;background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:18px}a{color:#17634f;font-weight:800}.ok{color:#17634f;font-weight:800}.muted{color:#6a7682;line-height:1.45}</style></head>
        <body><main class="card"><h1>Meta 重新授权完成</h1><p class="ok">已保存新的 Page token。</p><p>当前绑定主页：<strong>{{ page.name }}</strong> / {{ page.id }}</p><p class="muted">系统会优先使用这次授权保存到数据库里的 token，不再依赖旧的 Render Page token。</p><p><a href="/admin/meta/permission-checks">重新检查权限</a> · <a href="/">返回 CRM</a></p></main></body></html>
        """,
        page=selected,
        accounts=accounts,
    )
