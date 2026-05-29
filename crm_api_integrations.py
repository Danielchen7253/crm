"""CRM channel status and promotion posting workspace."""

import requests
from flask import jsonify, redirect, render_template_string, request

import app_live_new
import whatsapp_live

app = app_live_new.app
crm_module = app_live_new.crm_module


PAGE_CSS = """
:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}
*{box-sizing:border-box}body{margin:0}.top{height:58px;background:#16202a;color:#fff;display:flex;align-items:center;gap:12px;padding:0 16px}.back{color:#fff;text-decoration:none;font-weight:800}
.wrap{max-width:1180px;margin:0 auto;padding:18px 16px;display:grid;gap:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:16px}
h1{font-size:18px;margin:0}h2{font-size:16px;margin:0 0 10px}.muted{color:#6a7682;font-size:13px;line-height:1.45}.status{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:800}
.ok{background:#eef7f4;color:#17634f}.bad{background:#fff2f0;color:#a8071a}.warn{background:#fff7e6;color:#ad6800}.rows{display:grid;gap:8px}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;border-top:1px solid #edf0f4;padding-top:8px}
label{display:grid;gap:6px;color:#3e4b57;font-size:12px;font-weight:700}input,textarea,select{width:100%;border:1px solid #cfd7e2;border-radius:8px;padding:10px 12px;font:inherit;background:#fff}textarea{min-height:180px;resize:vertical}
.actions{display:flex;flex-wrap:wrap;gap:10px}.button,button{border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:800;cursor:pointer;font-size:14px;padding:11px 14px;text-decoration:none}.secondary{background:#e8edf3;color:#17202a}
.notice{border:1px solid #d8dee8;background:#f8fafb;border-radius:8px;padding:12px;color:#3e4b57;font-size:13px;line-height:1.45}.error{border-color:#ffccc7;background:#fff2f0;color:#a8071a}.success{border-color:#b7ebc6;background:#f6ffed;color:#17634f}
@media(max-width:700px){.grid{grid-template-columns:1fr}.wrap{padding:12px}.top{height:54px}.row{grid-template-columns:1fr}.actions{display:grid}.button,button{width:100%;text-align:center}}
"""


def install_navigation_links():
    extra_links = (
        '<a class="nav-link" href="/admin/channels"><span>API 接入状态</span><span class="nav-count">live</span></a>'
        '<a class="nav-link" href="/promotion"><span>推广发帖</span><span class="nav-count">post</span></a>'
    )
    if "/promotion" in app_live_new.TEMPLATE:
        return
    settings_link = '<a class="nav-link" href="/settings"><span>&#31995;&#32479;&#35774;&#32622;</span><span class="nav-count">lock</span></a>'
    app_live_new.TEMPLATE = app_live_new.TEMPLATE.replace(settings_link, extra_links + settings_link)


def safe_call(fn, fallback=None):
    try:
        return fn()
    except Exception as error:
        return fallback if fallback is not None else {"ok": False, "error": str(error)}


def graph_ok(path, params=None):
    try:
        return {"ok": True, "data": crm_module.graph_get(path, params or {})}
    except requests.RequestException as error:
        return {"ok": False, "error": meta_error(error)}


def meta_error(error):
    response = getattr(error, "response", None)
    if response is not None:
        try:
            payload = response.json()
            message = (payload.get("error") or {}).get("message")
            code = (payload.get("error") or {}).get("code")
            if message:
                return f"Meta API error {code}: {message}" if code else f"Meta API error: {message}"
        except ValueError:
            pass
        return f"Meta API HTTP {response.status_code}"
    return str(error)


def messenger_status():
    page_id = getattr(crm_module, "META_PAGE_ID", "")
    if not page_id or not getattr(crm_module, "META_PAGE_ACCESS_TOKEN", ""):
        return {"ready": False, "items": [{"name": "Messenger token", "ok": False, "detail": "not configured"}]}
    conversations = graph_ok(
        f"{page_id}/conversations",
        {"fields": "id,updated_time,participants{id,name,profile_pic}", "limit": "5"},
    )
    profile = graph_ok(f"{page_id}/conversations", {"fields": "participants{id,name,profile_pic}", "limit": "5"})
    webhook = graph_ok(f"{page_id}/subscribed_apps", {"fields": "id,name"})
    page_profile = graph_ok(page_id, {"fields": "id,name,category,link,picture"})
    return {
        "ready": bool(conversations.get("ok") and profile.get("ok")),
        "items": [
            {"name": "Messenger conversations", "ok": conversations.get("ok"), "detail": "can read Page inbox" if conversations.get("ok") else conversations.get("error")},
            {"name": "Customer name/avatar", "ok": profile.get("ok"), "detail": "can read participants profile fields" if profile.get("ok") else profile.get("error")},
            {"name": "Page webhook management", "ok": webhook.get("ok"), "detail": "can inspect subscribed apps" if webhook.get("ok") else webhook.get("error")},
            {"name": "Page engagement metadata", "ok": page_profile.get("ok"), "detail": "can read Page metadata" if page_profile.get("ok") else page_profile.get("error")},
        ],
    }


def whatsapp_status():
    configured = {
        "access token": bool(whatsapp_live.WHATSAPP_ACCESS_TOKEN),
        "phone number id": bool(whatsapp_live.WHATSAPP_PHONE_NUMBER_ID),
        "business account id": bool(whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID),
        "verify token": bool(whatsapp_live.WHATSAPP_VERIFY_TOKEN),
    }
    items = [{"name": f"WhatsApp {name}", "ok": ok, "detail": "configured" if ok else "missing"} for name, ok in configured.items()]
    if whatsapp_live.WHATSAPP_PHONE_NUMBER_ID:
        phone = safe_call(
            lambda: whatsapp_live.whatsapp_graph_get(
                whatsapp_live.WHATSAPP_PHONE_NUMBER_ID,
                {"fields": "id,display_phone_number,verified_name,quality_rating,name_status,platform_type"},
            )
        )
        items.append({"name": "WhatsApp phone number", "ok": "error" not in phone, "detail": phone if "error" not in phone else phone["error"]})
    if whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID:
        waba = safe_call(
            lambda: whatsapp_live.whatsapp_graph_get(
                whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID,
                {"fields": "id,name,account_review_status"},
            )
        )
        items.append({"name": "WhatsApp business account", "ok": "error" not in waba and waba.get("account_review_status") == "APPROVED", "detail": waba if "error" not in waba else waba["error"]})
        subscribed = safe_call(lambda: whatsapp_live.whatsapp_graph_get(f"{whatsapp_live.WHATSAPP_BUSINESS_ACCOUNT_ID}/subscribed_apps"))
        items.append({"name": "WhatsApp webhook subscription", "ok": "error" not in subscribed, "detail": "subscribed" if "error" not in subscribed else subscribed["error"]})
    return {"ready": all(item["ok"] for item in items[:4]) and any(item["name"] == "WhatsApp webhook subscription" and item["ok"] for item in items), "items": items}


def promotion_status():
    page_id = getattr(crm_module, "META_PAGE_ID", "")
    if not page_id:
        return {"ready": False, "detail": "META_PAGE_ID missing"}
    probe = graph_ok(page_id, {"fields": "id,name"})
    return {"ready": bool(probe.get("ok")), "detail": "Facebook Page connected" if probe.get("ok") else probe.get("error")}


def api_status_payload():
    return {
        "ok": True,
        "messenger": messenger_status(),
        "whatsapp": whatsapp_status(),
        "promotion": promotion_status(),
    }


def save_promotion_record(payload):
    try:
        return crm_module.sb_post("promotion_posts", payload)[0]
    except Exception:
        return None


CHANNELS_TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>API 接入状态</title><style>{{ css }}</style></head>
<body><header class="top"><a class="back" href="/">&lsaquo; CRM</a><h1>API 接入状态</h1></header><main class="wrap">
<div class="grid">
{% for title, block in [('Messenger', status['messenger']), ('WhatsApp', status['whatsapp'])] %}
<section class="card"><h2>{{ title }} <span class="status {{ 'ok' if block.ready else 'warn' }}">{{ '已接入' if block.ready else '部分可用' }}</span></h2><div class="rows">
{% for item in block['items'] %}<div class="row"><div><strong>{{ item['name'] }}</strong><div class="muted">{{ item['detail'] }}</div></div><span class="status {{ 'ok' if item['ok'] else 'bad' }}">{{ 'OK' if item['ok'] else '缺少权限' }}</span></div>{% endfor %}
</div></section>
{% endfor %}
</div>
<section class="card"><h2>推广发帖 <span class="status {{ 'ok' if status['promotion']['ready'] else 'warn' }}">{{ '页面已接入' if status['promotion']['ready'] else '等待发帖权限' }}</span></h2>
<p class="muted">{{ status['promotion']['detail'] }}</p><div class="actions"><a class="button" href="/promotion">打开推广发帖页面</a><form method="post" action="/admin/import/messenger-conversations/all"><button type="submit" class="secondary">同步 Messenger 客户</button></form></div></section>
</main></body></html>
"""


PROMOTION_TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>推广发帖</title><style>{{ css }}</style></head>
<body><header class="top"><a class="back" href="/">&lsaquo; CRM</a><h1>推广发帖</h1></header><main class="wrap">
{% if message %}<div class="notice {{ 'success' if success else 'error' }}">{{ message }}</div>{% endif %}
<section class="card"><h2>新推广内容</h2><form method="post" action="/promotion/posts" class="rows">
<label>发布渠道<select name="channel"><option value="facebook_page">Facebook Page 帖子</option><option value="draft">只保存草稿</option></select></label>
<label>标题<input name="title" placeholder="例：Houston refrigerator gasket replacement"></label>
<label>发帖内容<textarea name="content" placeholder="输入要发布或保存的推广内容" required></textarea></label>
<div class="actions"><button name="action" value="draft" type="submit" class="secondary">保存草稿</button><button name="action" value="publish" type="submit">尝试发布到 Page</button></div>
</form></section>
<section class="card"><h2>当前接入状态</h2><div class="rows">
<div class="row"><div><strong>Facebook Page</strong><div class="muted">{{ promotion['detail'] }}</div></div><span class="status {{ 'ok' if promotion['ready'] else 'warn' }}">{{ '已连接' if promotion['ready'] else '部分可用' }}</span></div>
<div class="row"><div><strong>说明</strong><div class="muted">发帖 API 需要 pages_manage_posts。现在页面先接好入口和发布调用；如果 Meta 还没批准，点击发布会显示 Meta 返回的权限错误。</div></div><span class="status warn">按权限启用</span></div>
</div></section>
</main></body></html>
"""


@app.get("/admin/channels")
def channel_status_page():
    return render_template_string(CHANNELS_TEMPLATE, css=PAGE_CSS, status=api_status_payload())


@app.get("/api/channels/status")
def channel_status_json():
    return jsonify(api_status_payload())


@app.get("/promotion")
def promotion_page():
    return render_template_string(PROMOTION_TEMPLATE, css=PAGE_CSS, promotion=promotion_status(), message=request.args.get("message", ""), success=request.args.get("success") == "1")


@app.post("/promotion/posts")
def promotion_post_submit():
    title = request.form.get("title", "").strip()
    content = request.form.get("content", "").strip()
    channel = request.form.get("channel", "facebook_page").strip()
    action = request.form.get("action", "draft").strip()
    if not content:
        return redirect("/promotion?success=0&message=Content%20is%20required", code=303)

    payload = {
        "title": title or content[:60],
        "content": content,
        "channel": channel,
        "status": "draft",
        "raw_result": {},
        "created_at": crm_module.now_iso(),
        "updated_at": crm_module.now_iso(),
    }
    if action == "publish" and channel == "facebook_page":
        try:
            result = crm_module.graph_post(f"{crm_module.META_PAGE_ID}/feed", {"message": content})
            payload["status"] = "published"
            payload["raw_result"] = result
            save_promotion_record(payload)
            return redirect("/promotion?success=1&message=Posted%20to%20Facebook%20Page", code=303)
        except requests.RequestException as error:
            payload["status"] = "failed"
            payload["raw_result"] = {"error": meta_error(error)}
            save_promotion_record(payload)
            return redirect(f"/promotion?success=0&message={requests.utils.quote(meta_error(error)[:240])}", code=303)

    save_promotion_record(payload)
    return redirect("/promotion?success=1&message=Draft%20saved", code=303)


install_navigation_links()
