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
        params={"on_conflict": "provider,key"},
        headers=crm_module.sb_headers("resolution=merge-duplicates,return=representation"),
        json=row,
        timeout=20,
    )
    response.raise_for_status()
    crm_module.META_CONFIG_CACHE["loaded_at"] = None
    return response.json()


def redacted_error(error):
    text = str(error)
    for secret in [
        crm_module.current_meta_page_access_token(),
        crm_module.current_meta_app_secret(),
        crm_module.SUPABASE_SERVICE_ROLE_KEY,
    ]:
        if secret:
            text = text.replace(secret, "[redacted]")
    response = getattr(error, "response", None)
    if response is not None:
        try:
            detail = response.json()
            message = (detail.get("error") or {}).get("message")
            if message:
                return message
        except ValueError:
            pass
    return text


def verify_and_save_page_token(page_id, page_token):
    page_id = (page_id or "").strip()
    page_token = (page_token or "").strip()
    if not page_id or not page_token:
        raise RuntimeError("Page ID and Page access token are required.")
    conversations = graph_get_with_token(
        f"{page_id}/conversations",
        page_token,
        {"fields": "id,updated_time,participants{id,name,profile_pic}", "limit": "5"},
    )
    profile_check = graph_get_with_token(
        f"{page_id}/conversations",
        page_token,
        {"fields": "participants{id,name,profile_pic}", "limit": "5"},
    )
    save_setting("page_id", page_id, {"source": "manual_token"})
    save_setting(
        "page_access_token",
        page_token,
        {
            "source": "manual_token",
            "conversation_count": len(conversations.get("data") or []),
            "profile_count": len(profile_check.get("data") or []),
        },
    )
    return {
        "page_id": page_id,
        "conversation_count": len(conversations.get("data") or []),
        "profile_count": len(profile_check.get("data") or []),
    }


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


MANUAL_TOKEN_TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meta 手动接入</title><style>:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}.top{height:58px;background:#16202a;color:#fff;display:flex;align-items:center;gap:12px;padding:0 16px}.back{color:#fff;text-decoration:none;font-weight:800}.wrap{max-width:760px;margin:0 auto;padding:18px 16px;display:grid;gap:14px}.card{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:16px}h1{font-size:18px;margin:0}h2{font-size:16px;margin:0 0 10px}.muted{color:#6a7682;font-size:13px;line-height:1.45}label{display:grid;gap:6px;color:#3e4b57;font-size:12px;font-weight:700}input,textarea{width:100%;border:1px solid #cfd7e2;border-radius:8px;padding:10px 12px;font:inherit;background:#fff}textarea{min-height:130px;resize:vertical}button,.button{border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:800;cursor:pointer;font-size:14px;padding:11px 14px;text-decoration:none}.notice{border:1px solid #d8dee8;background:#f8fafb;border-radius:8px;padding:12px;color:#3e4b57;font-size:13px;line-height:1.45}.error{border-color:#ffccc7;background:#fff2f0;color:#a8071a}.success{border-color:#b7ebc6;background:#f6ffed;color:#17634f}.rows{display:grid;gap:12px}.code{font-family:Consolas,monospace;background:#f8fafb;border:1px solid #d8dee8;border-radius:8px;padding:10px;white-space:pre-wrap;word-break:break-all}</style></head>
<body><header class="top"><a class="back" href="/">&lsaquo; CRM</a><h1>Meta 手动接入</h1></header><main class="wrap">
{% if message %}<div class="notice {{ 'success' if success else 'error' }}">{{ message }}</div>{% endif %}
<section class="card"><h2>粘贴新的 Page Token</h2><form method="post" class="rows">
<label>Facebook Page ID<input name="page_id" value="{{ page_id }}" required></label>
<label>Page Access Token<textarea name="page_token" required placeholder="EA..."></textarea></label>
<button type="submit">保存并测试</button></form></section>
<section class="card"><h2>怎么拿 token</h2><div class="muted">打开 Graph API Explorer，选择 CRM 这个 App，授权 pages_show_list、pages_messaging、pages_manage_metadata、pages_read_engagement，然后选择 Coolfixpro Supply Depot 主页，复制 Page Access Token 粘贴到这里。</div><p><a class="button" href="https://developers.facebook.com/tools/explorer/1528469058632372/" target="_blank" rel="noopener">打开 Graph API Explorer</a></p><div class="code">回调地址需要加入 Meta OAuth 白名单：
https://crm-8t7y.onrender.com/admin/meta/oauth/callback</div></section>
</main></body></html>
"""


@app.route("/admin/meta/manual-token", methods=["GET", "POST"])
def meta_manual_token():
    message = ""
    success = False
    if request.method == "POST":
        try:
            result = verify_and_save_page_token(request.form.get("page_id"), request.form.get("page_token"))
            message = f"保存成功。读取到 {result['conversation_count']} 个对话检查结果。"
            success = True
        except Exception as error:
            message = redacted_error(error)
    return render_template_string(
        MANUAL_TOKEN_TEMPLATE,
        message=message,
        success=success,
        page_id=crm_module.current_meta_page_id() or crm_module.META_PAGE_ID,
    )


@app.get("/admin/meta/oauth/callback")
def meta_oauth_callback():
    if request.args.get("error"):
        return jsonify({"ok": False, "error": request.args.get("error_description") or request.args.get("error")}), 400
    if request.args.get("state") != session.get("meta_oauth_state"):
        return render_template_string(
            MANUAL_TOKEN_TEMPLATE,
            message="授权状态已过期。请从 CRM 的重新授权入口重新开始，或在这里手动粘贴 Page token。",
            success=False,
            page_id=crm_module.current_meta_page_id() or crm_module.META_PAGE_ID,
        ), 400
    code = request.args.get("code")
    if not code:
        return jsonify({"ok": False, "error": "Missing OAuth code."}), 400
    try:
        user_token = exchange_code_for_user_token(code)
        selected, accounts = save_first_page(user_token)
    except Exception as error:
        return render_template_string(
            MANUAL_TOKEN_TEMPLATE,
            message=redacted_error(error),
            success=False,
            page_id=crm_module.current_meta_page_id() or crm_module.META_PAGE_ID,
        ), 502
    return render_template_string(
        """
        <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Meta 重新授权完成</title><style>:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}body{margin:0;padding:24px}.card{max-width:680px;margin:0 auto;background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:18px}a{color:#17634f;font-weight:800}.ok{color:#17634f;font-weight:800}.muted{color:#6a7682;line-height:1.45}</style></head>
        <body><main class="card"><h1>Meta 重新授权完成</h1><p class="ok">已保存新的 Page token。</p><p>当前绑定主页：<strong>{{ page.name }}</strong> / {{ page.id }}</p><p class="muted">系统会优先使用这次授权保存到数据库里的 token，不再依赖旧的 Render Page token。</p><p><a href="/admin/meta/permission-checks">重新检查权限</a> · <a href="/">返回 CRM</a></p></main></body></html>
        """,
        page=selected,
        accounts=accounts,
    )
