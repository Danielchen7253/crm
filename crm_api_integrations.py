"""CRM channel status and promotion posting workspace."""

from urllib.parse import quote

import requests
from flask import jsonify, redirect, render_template_string, request

import app_live_new
import whatsapp_live

app = app_live_new.app
crm_module = app_live_new.crm_module


PAGE_CSS = """
:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}
*{box-sizing:border-box}body{margin:0}.top{height:58px;background:#16202a;color:#fff;display:flex;align-items:center;gap:12px;padding:0 16px}.back{color:#fff;text-decoration:none;font-weight:800}
.wrap{max-width:1320px;margin:0 auto;padding:18px 16px;display:grid;gap:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.workbench{display:grid;grid-template-columns:0.95fr 0.95fr 1.1fr;gap:14px;align-items:start}
.card{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:16px;min-width:0}.compact{padding:12px}
h1{font-size:18px;margin:0}h2{font-size:16px;margin:0 0 10px}.muted{color:#6a7682;font-size:13px;line-height:1.45}.tiny{font-size:12px}.strong{font-weight:800}
.status{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:800;white-space:nowrap}.ok{background:#eef7f4;color:#17634f}.bad{background:#fff2f0;color:#a8071a}.warn{background:#fff7e6;color:#ad6800}.info{background:#eef4ff;color:#1d4ed8}
.rows{display:grid;gap:9px}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;border-top:1px solid #edf0f4;padding-top:9px}.row:first-child{border-top:0;padding-top:0}
label{display:grid;gap:6px;color:#3e4b57;font-size:12px;font-weight:700}input,textarea,select{width:100%;border:1px solid #cfd7e2;border-radius:8px;padding:10px 12px;font:inherit;background:#fff}textarea{min-height:220px;resize:vertical}.short textarea{min-height:96px}
.actions{display:flex;flex-wrap:wrap;gap:10px}.button,button{border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:800;cursor:pointer;font-size:14px;padding:11px 14px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.secondary{background:#e8edf3;color:#17202a}.danger{background:#fff2f0;color:#a8071a}.ghost{background:#f7f9fb;color:#17202a;border:1px solid #d8dee8}
.notice{border:1px solid #d8dee8;background:#f8fafb;border-radius:8px;padding:12px;color:#3e4b57;font-size:13px;line-height:1.45}.error{border-color:#ffccc7;background:#fff2f0;color:#a8071a}.success{border-color:#b7ebc6;background:#f6ffed;color:#17634f}
.list{display:grid;gap:8px}.list-item{border:1px solid #e3e8ef;border-radius:8px;padding:10px;background:#fbfcfd;display:grid;gap:8px}.list-item.active{border-color:#1f8a70;background:#f2fbf8}.titleline{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.titleline a{color:#17202a;text-decoration:none}.clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.preview{color:#3e4b57;font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
.group-card{border:1px solid #e3e8ef;border-radius:8px;padding:10px;display:grid;gap:8px;background:#fff}.group-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px}.group-name{font-weight:800}.group-meta{display:flex;flex-wrap:wrap;gap:6px;color:#6a7682;font-size:12px}.group-actions{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.selected-copy{position:absolute;left:-9999px;top:-9999px}
@media(max-width:980px){.workbench{grid-template-columns:1fr}.grid{grid-template-columns:1fr}.wrap{padding:12px}.top{height:54px}.row{grid-template-columns:1fr}.actions,.group-actions{display:grid;grid-template-columns:1fr}.button,button{width:100%;text-align:center}}
"""


def install_navigation_links():
    extra_links = (
        '<a class="nav-link" href="/admin/channels"><span>API 接入状态</span><span class="nav-count">live</span></a>'
        '<a class="nav-link" href="/promotion"><span>群组发帖</span><span class="nav-count">post</span></a>'
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
    page_id = crm_module.current_meta_page_id()
    if not page_id or not crm_module.current_meta_page_access_token():
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
    page_id = crm_module.current_meta_page_id()
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


def promotion_table_error(error):
    return "群组发帖数据表还没有建好：" + str(error)


def get_promotion_posts():
    return crm_module.sb_get_all(
        "promotion_posts",
        {"select": "id,title,content,channel,status,created_at,updated_at", "order": "created_at.desc", "limit": "30"},
        page_size=30,
        max_rows=30,
    )


def get_selected_post(post_id=None):
    if post_id:
        rows = crm_module.sb_get("promotion_posts", {"select": "*", "id": f"eq.{post_id}", "limit": "1"})
        if rows:
            return rows[0]
    posts = get_promotion_posts()
    return posts[0] if posts else None


def get_promotion_groups():
    return crm_module.sb_get_all(
        "promotion_groups",
        {"select": "*", "status": "neq.disabled", "order": "last_posted_at.asc.nullsfirst,created_at.desc"},
        page_size=500,
        max_rows=5000,
    )


def get_group_logs(post_id):
    if not post_id:
        return []
    return crm_module.sb_get_all(
        "promotion_group_logs",
        {"select": "*,promotion_groups(name,url)", "promotion_post_id": f"eq.{post_id}", "order": "created_at.desc"},
        page_size=500,
        max_rows=5000,
    )


def group_log_map(logs):
    latest = {}
    for log in logs:
        group_id = log.get("group_id")
        if group_id and group_id not in latest:
            latest[group_id] = log
    return latest


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
<section class="card"><h2>群组发帖 <span class="status {{ 'ok' if status['promotion']['ready'] else 'warn' }}">{{ '页面已接入' if status['promotion']['ready'] else '等待发帖权限' }}</span></h2>
<p class="muted">{{ status['promotion']['detail'] }}</p><div class="actions"><a class="button" href="/promotion">打开群组发帖工作台</a><form method="post" action="/admin/import/messenger-conversations/all"><button type="submit" class="secondary">同步 Messenger 客户</button></form></div></section>
</main></body></html>
"""


PROMOTION_TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>群组发帖工作台</title><style>{{ css }}</style></head>
<body><header class="top"><a class="back" href="/">&lsaquo; CRM</a><h1>群组发帖工作台</h1></header><main class="wrap">
{% if message %}<div class="notice {{ 'success' if success else 'error' }}">{{ message }}</div>{% endif %}
{% if setup_error %}<div class="notice error">{{ setup_error }}</div>{% endif %}

<div class="workbench">
<section class="card">
  <h2>发帖文案</h2>
  <form method="post" action="/promotion/posts" class="rows">
    <label>发布渠道
      <select name="channel">
        <option value="facebook_group">Facebook 群组工作台</option>
        <option value="facebook_page">Facebook Page 帖子</option>
        <option value="draft">只保存草稿</option>
      </select>
    </label>
    <label>标题<input name="title" value="{{ selected_post.title if selected_post else '' }}" placeholder="例如：Houston refrigerator gasket replacement"></label>
    <label>发帖内容<textarea id="post-content" name="content" placeholder="输入这次要复制到群组的推广内容" required>{{ selected_post.content if selected_post else '' }}</textarea></label>
    <div class="actions">
      <button name="action" value="draft" type="submit" class="secondary">保存文案</button>
      <button name="action" value="publish" type="submit">发到 Page</button>
    </div>
  </form>
  <div class="notice">
    当前模式：先把所有群组集中管理，逐个打开群组、复制文案、标记已发。这样不会触发平台对机器群发的高风险限制。
  </div>
</section>

<section class="card">
  <h2>文案库</h2>
  <div class="list">
    {% if posts %}
      {% for post in posts %}
      <div class="list-item {{ 'active' if selected_post and post.id == selected_post.id else '' }}">
        <div class="titleline">
          <a class="strong clip" href="/promotion?post={{ post.id }}">{{ post.title or '未命名文案' }}</a>
          <span class="status {{ 'ok' if post.status == 'published' else 'info' }}">{{ post.status }}</span>
        </div>
        <div class="preview">{{ post.content }}</div>
        <div class="muted tiny">{{ post.channel }} · {{ post.created_at }}</div>
      </div>
      {% endfor %}
    {% else %}
      <div class="notice">还没有保存文案。先在左边写一条并保存。</div>
    {% endif %}
  </div>
</section>

<section class="card">
  <h2>添加群组</h2>
  <form method="post" action="/promotion/groups" class="rows">
    <label>群组名称<input name="name" placeholder="例如：Houston Appliance Repair"></label>
    <label>群组链接<input name="url" placeholder="https://www.facebook.com/groups/..."></label>
    <label>分类<input name="category" placeholder="冰箱 / 维修 / 本地买卖"></label>
    <label>备注<textarea name="notes" placeholder="这个群适合发什么、多久发一次"></textarea></label>
    <button type="submit">保存群组</button>
  </form>
</section>
</div>

<section class="card">
  <div class="titleline">
    <h2>群组执行区</h2>
    <span class="status info">{{ groups|length }} 个群组</span>
  </div>
  <textarea class="selected-copy" id="copy-buffer">{{ selected_post.content if selected_post else '' }}</textarea>
  <div class="list">
    {% if groups %}
      {% for group in groups %}
      {% set log = log_by_group.get(group.id) %}
      <div class="group-card">
        <div class="group-head">
          <div>
            <div class="group-name clip">{{ group.name }}</div>
            <div class="group-meta"><span>{{ group.category or '未分类' }}</span><span>上次：{{ group.last_posted_at or '未发过' }}</span></div>
          </div>
          <span class="status {{ 'ok' if log and log.status == 'published' else 'warn' }}">{{ log.status if log else '待执行' }}</span>
        </div>
        <div class="muted clip">{{ group.url }}</div>
        {% if group.notes %}<div class="muted">{{ group.notes }}</div>{% endif %}
        <div class="group-actions">
          <a class="button secondary" href="{{ group.url }}" target="_blank" rel="noopener">打开群组</a>
          <button type="button" class="ghost copy-post">复制文案</button>
          <form method="post" action="/promotion/groups/{{ group.id }}/mark">
            <input type="hidden" name="post_id" value="{{ selected_post.id if selected_post else '' }}">
            <button type="submit">标记已发</button>
          </form>
        </div>
      </div>
      {% endfor %}
    {% else %}
      <div class="notice">还没有群组。先把你常用的 Facebook 群组链接加进来。</div>
    {% endif %}
  </div>
</section>

<script>
(function(){
  function copyCurrentPost(){
    var el = document.getElementById('copy-buffer') || document.getElementById('post-content');
    var text = el ? el.value : '';
    if (!text.trim()) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      el.focus();
      el.select();
      document.execCommand('copy');
    }
  }
  document.querySelectorAll('.copy-post').forEach(function(button){
    button.addEventListener('click', function(){
      copyCurrentPost();
      var old = button.textContent;
      button.textContent = '已复制';
      setTimeout(function(){ button.textContent = old; }, 900);
    });
  });
})();
</script>
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
    setup_error = ""
    posts = []
    groups = []
    logs = []
    selected_post = None
    try:
        selected_post = get_selected_post(request.args.get("post"))
        posts = get_promotion_posts()
        groups = get_promotion_groups()
        logs = get_group_logs(selected_post.get("id") if selected_post else None)
    except Exception as error:
        setup_error = promotion_table_error(error)
    return render_template_string(
        PROMOTION_TEMPLATE,
        css=PAGE_CSS,
        promotion=promotion_status(),
        message=request.args.get("message", ""),
        success=request.args.get("success") == "1",
        setup_error=setup_error,
        posts=posts,
        groups=groups,
        selected_post=selected_post,
        log_by_group=group_log_map(logs),
    )


@app.post("/promotion/posts")
def promotion_post_submit():
    title = request.form.get("title", "").strip()
    content = request.form.get("content", "").strip()
    channel = request.form.get("channel", "facebook_group").strip()
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
            result = crm_module.graph_post(f"{crm_module.current_meta_page_id()}/feed", {"message": content})
            payload["status"] = "published"
            payload["raw_result"] = result
            saved = save_promotion_record(payload)
            post_param = f"&post={saved['id']}" if saved and saved.get("id") else ""
            return redirect(f"/promotion?success=1&message=Posted%20to%20Facebook%20Page{post_param}", code=303)
        except requests.RequestException as error:
            payload["status"] = "failed"
            payload["raw_result"] = {"error": meta_error(error)}
            saved = save_promotion_record(payload)
            post_param = f"&post={saved['id']}" if saved and saved.get("id") else ""
            return redirect(f"/promotion?success=0&message={quote(meta_error(error)[:240])}{post_param}", code=303)

    saved = save_promotion_record(payload)
    post_param = f"&post={saved['id']}" if saved and saved.get("id") else ""
    return redirect(f"/promotion?success=1&message=Draft%20saved{post_param}", code=303)


@app.post("/promotion/groups")
def promotion_group_submit():
    name = request.form.get("name", "").strip()
    url = request.form.get("url", "").strip()
    category = request.form.get("category", "").strip()
    notes = request.form.get("notes", "").strip()
    if not name or not url:
        return redirect("/promotion?success=0&message=Group%20name%20and%20url%20are%20required", code=303)
    payload = {
        "name": name,
        "url": url,
        "category": category,
        "notes": notes,
        "status": "active",
        "created_at": crm_module.now_iso(),
        "updated_at": crm_module.now_iso(),
    }
    try:
        crm_module.sb_post("promotion_groups", payload)
        return redirect("/promotion?success=1&message=Group%20saved", code=303)
    except Exception as error:
        return redirect(f"/promotion?success=0&message={quote(str(error)[:240])}", code=303)


@app.post("/promotion/groups/<group_id>/mark")
def promotion_group_mark(group_id):
    post_id = request.form.get("post_id", "").strip()
    now = crm_module.now_iso()
    try:
        crm_module.sb_post(
            "promotion_group_logs",
            {
                "promotion_post_id": post_id or None,
                "group_id": group_id,
                "status": "published",
                "posted_at": now,
                "notes": "",
                "created_at": now,
                "updated_at": now,
            },
        )
        crm_module.sb_patch("promotion_groups", {"last_posted_at": now, "updated_at": now}, {"id": f"eq.{group_id}"})
        post_param = f"&post={post_id}" if post_id else ""
        return redirect(f"/promotion?success=1&message=Marked%20as%20posted{post_param}", code=303)
    except Exception as error:
        return redirect(f"/promotion?success=0&message={quote(str(error)[:240])}", code=303)


install_navigation_links()
