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
.wrap{max-width:1540px;margin:0 auto;padding:18px 16px;display:grid;gap:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.station{display:grid;grid-template-columns:0.7fr 1.3fr;gap:14px;align-items:start}
.card{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:16px;min-width:0}h1{font-size:18px;margin:0}h2{font-size:16px;margin:0 0 10px}.muted{color:#6a7682;font-size:13px;line-height:1.45}.tiny{font-size:12px}.strong{font-weight:800}
.status{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:800;white-space:nowrap}.ok{background:#eef7f4;color:#17634f}.bad{background:#fff2f0;color:#a8071a}.warn{background:#fff7e6;color:#ad6800}.info{background:#eef4ff;color:#1d4ed8}
.rows{display:grid;gap:9px}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center;border-top:1px solid #edf0f4;padding-top:9px}.row:first-child{border-top:0;padding-top:0}
label{display:grid;gap:6px;color:#3e4b57;font-size:12px;font-weight:700}input,textarea,select{width:100%;border:1px solid #cfd7e2;border-radius:8px;padding:10px 12px;font:inherit;background:#fff}textarea{min-height:210px;resize:vertical}.short-textarea{min-height:110px}
.actions{display:flex;flex-wrap:wrap;gap:10px}.button,button{border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:800;cursor:pointer;font-size:14px;padding:11px 14px;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}.secondary{background:#e8edf3;color:#17202a}.ghost{background:#f7f9fb;color:#17202a;border:1px solid #d8dee8}
.notice{border:1px solid #d8dee8;background:#f8fafb;border-radius:8px;padding:12px;color:#3e4b57;font-size:13px;line-height:1.45}.error{border-color:#ffccc7;background:#fff2f0;color:#a8071a}.success{border-color:#b7ebc6;background:#f6ffed;color:#17634f}
.material-preview{border:1px solid #e3e8ef;border-radius:8px;overflow:hidden;background:#fbfcfd;display:grid;gap:0}.material-preview img,.material-preview video{width:100%;display:block;max-height:260px;object-fit:contain;background:#f7f9fb}.material-preview .empty{padding:24px;text-align:center;color:#6a7682}
.task{display:grid;gap:12px}.current-group{border:1px solid #1f8a70;background:#f2fbf8;border-radius:8px;padding:14px;display:grid;gap:10px}.task-title{font-size:20px;font-weight:900}.task-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}.selected-copy{position:absolute;left:-9999px;top:-9999px}.facebook-frame{width:100%;height:720px;border:1px solid #d8dee8;border-radius:8px;background:#fff}.frame-note{margin-top:8px}
.list{display:grid;gap:8px}.list-item{border:1px solid #e3e8ef;border-radius:8px;padding:10px;background:#fbfcfd;display:grid;gap:8px}.list-item.active{border-color:#1f8a70;background:#f2fbf8}.titleline{display:flex;justify-content:space-between;gap:10px;align-items:flex-start}.titleline a{color:#17202a;text-decoration:none}.clip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.preview{color:#3e4b57;font-size:13px;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:pre-wrap}
.group-list{display:grid;gap:7px;max-height:360px;overflow:auto;padding-right:4px}.group-row{display:grid;grid-template-columns:34px minmax(0,1fr) auto;gap:10px;align-items:center;border:1px solid #e3e8ef;border-radius:8px;background:#fff;padding:9px;text-decoration:none;color:#17202a}.group-row.current{border-color:#1f8a70;background:#f2fbf8}.group-row.done{opacity:.72}.badge{height:24px;min-width:24px;border-radius:999px;background:#e8edf3;display:inline-flex;align-items:center;justify-content:center;font-size:12px;font-weight:900}.done .badge{background:#eef7f4;color:#17634f}
@media(max-width:980px){.station,.grid{grid-template-columns:1fr}.wrap{padding:12px}.top{height:54px}.row{grid-template-columns:1fr}.actions,.task-actions{display:grid;grid-template-columns:1fr}.button,button{width:100%;text-align:center}.group-list{max-height:none}}
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
        {"select": "id,title,content,image_url,video_url,channel,status,created_at,updated_at", "order": "created_at.desc", "limit": "30"},
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
        {"select": "*", "status": "neq.disabled", "order": "last_posted_at.asc.nullsfirst,created_at.asc"},
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


def choose_current_group(groups, log_by_group, group_id=None):
    if group_id:
        for group in groups:
            if group.get("id") == group_id:
                return group
    for group in groups:
        log = log_by_group.get(group.get("id"))
        if not log or log.get("status") != "published":
            return group
    return groups[0] if groups else None


def next_group_after(groups, current_group):
    if not groups or not current_group:
        return None
    ids = [group.get("id") for group in groups]
    try:
        index = ids.index(current_group.get("id"))
    except ValueError:
        return groups[0]
    return groups[(index + 1) % len(groups)] if len(groups) > 1 else current_group


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
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>群组发帖工作站</title><style>{{ css }}</style></head>
<body><header class="top"><a class="back" href="/">&lsaquo; CRM</a><h1>群组发帖工作站</h1></header><main class="wrap">
{% if message %}<div class="notice {{ 'success' if success else 'error' }}">{{ message }}</div>{% endif %}
{% if setup_error %}<div class="notice error">{{ setup_error }}</div>{% endif %}

<div class="station">
<section class="card">
  <h2>左侧：图片和文章</h2>
  <form method="post" action="/promotion/posts" class="rows">
    <input type="hidden" name="channel" value="facebook_group">
    <label>标题<input name="title" value="{{ selected_post.title if selected_post else '' }}" placeholder="例如：Houston refrigerator gasket replacement"></label>
    <label>图片链接<input id="image-url" name="image_url" value="{{ selected_post.image_url if selected_post and selected_post.image_url else '' }}" placeholder="https://...jpg 或产品图片链接"></label>
    <label>视频链接<input id="video-url" name="video_url" value="{{ selected_post.video_url if selected_post and selected_post.video_url else '' }}" placeholder="/static/promotion_assets/example.mp4"></label>
    <div class="material-preview" id="image-preview">
      {% if selected_post and selected_post.image_url %}
      <img src="{{ selected_post.image_url }}" alt="发帖图片">
      {% else %}
      <div class="empty">这里显示准备发布的图片</div>
      {% endif %}
    </div>
    <div class="material-preview" id="video-preview">
      {% if selected_post and selected_post.video_url %}
      <video src="{{ selected_post.video_url }}" controls muted></video>
      {% else %}
      <div class="empty">这里显示准备发布的视频</div>
      {% endif %}
    </div>
    <label>准备发的文章<textarea id="post-content" name="content" placeholder="输入要发到群组的文章" required>{{ selected_post.content if selected_post else '' }}</textarea></label>
    <div class="actions">
      <button name="action" value="draft" type="submit" class="secondary">保存素材</button>
      <button type="button" class="ghost copy-post">复制文章</button>
      <a class="button secondary" id="open-image" href="{{ selected_post.image_url if selected_post and selected_post.image_url else '#' }}" target="_blank" rel="noopener">打开图片</a>
      <a class="button secondary" id="open-video" href="{{ selected_post.video_url if selected_post and selected_post.video_url else '#' }}" target="_blank" rel="noopener">打开视频</a>
    </div>
  </form>
</section>

<section class="card task">
  <div class="titleline">
    <h2>右侧：当前群组</h2>
    <span class="status info">{{ groups|length }} 个群组</span>
  </div>
  <textarea class="selected-copy" id="copy-buffer">{{ selected_post.content if selected_post else '' }}</textarea>
  {% if current_group %}
  {% set current_log = log_by_group.get(current_group.id) %}
  <div class="current-group">
    <div class="muted">当前要发</div>
    <div class="task-title">{{ current_group.name }}</div>
    <div class="muted clip">{{ current_group.url }}</div>
    <div class="group-meta"><span>{{ current_group.category or '未分类' }}</span><span>上次：{{ current_group.last_posted_at or '未发过' }}</span><span>{{ current_log.status if current_log else '待执行' }}</span></div>
    <div class="task-actions">
      <button type="button" class="open-in-frame" data-url="{{ current_group.url }}">在右侧打开</button>
      <button type="button" class="ghost copy-post">复制文章</button>
      <form method="post" action="/promotion/groups/{{ current_group.id }}/mark">
        <input type="hidden" name="post_id" value="{{ selected_post.id if selected_post else '' }}">
        <input type="hidden" name="next_group_id" value="{{ next_group.id if next_group else '' }}">
        <button type="submit">标记已发/下一个</button>
      </form>
      {% if next_group %}<a class="button secondary" href="/promotion?post={{ selected_post.id if selected_post else '' }}&group={{ next_group.id }}">跳到下一个</a>{% endif %}
      <a class="button secondary" href="{{ current_group.url }}" target="_blank" rel="noopener">外部打开</a>
    </div>
  </div>
  {% else %}
  <div class="notice">还没有群组。下面先添加或导入群组链接。</div>
  {% endif %}

  {% if current_group %}
  <iframe class="facebook-frame" id="facebook-frame" src="{{ current_group.url }}"></iframe>
  <div class="notice frame-note">点击群组会优先在右侧显示。如果 Facebook 阻止内嵌显示，再用“外部打开”。这是 Facebook 的网页安全限制，不是 CRM 页面坏了。</div>
  {% endif %}

  <h2>发帖队列</h2>
  <div class="group-list">
    {% for group in groups %}
    {% set log = log_by_group.get(group.id) %}
    <a class="group-row {{ 'current' if current_group and group.id == current_group.id else '' }} {{ 'done' if log and log.status == 'published' else '' }}" href="/promotion?post={{ selected_post.id if selected_post else '' }}&group={{ group.id }}" data-frame-url="{{ group.url }}">
      <span class="badge">{{ loop.index }}</span>
      <span class="clip"><strong>{{ group.name }}</strong><br><span class="muted tiny">{{ group.category or '未分类' }} · {{ group.last_posted_at or '未发过' }}</span></span>
      <span class="status {{ 'ok' if log and log.status == 'published' else 'warn' }}">{{ '已发' if log and log.status == 'published' else '待发' }}</span>
    </a>
    {% endfor %}
  </div>
</section>
</div>

<div class="grid">
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
    <label>分类<input name="category" value="Houston HVAC" placeholder="冰箱 / 维修 / 本地买卖"></label>
    <label>备注<textarea class="short-textarea" name="notes" placeholder="这个群适合发什么、多久发一次"></textarea></label>
    <button type="submit">保存群组</button>
  </form>
</section>
</div>

<script>
(function(){
  var imageInput = document.getElementById('image-url');
  var videoInput = document.getElementById('video-url');
  var imagePreview = document.getElementById('image-preview');
  var videoPreview = document.getElementById('video-preview');
  var openImage = document.getElementById('open-image');
  var openVideo = document.getElementById('open-video');
  function currentText(){
    var live = document.getElementById('post-content');
    var saved = document.getElementById('copy-buffer');
    return live && live.value.trim() ? live.value : (saved ? saved.value : '');
  }
  function copyCurrentPost(){
    var text = currentText();
    if (!text.trim()) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      var el = document.getElementById('post-content') || document.getElementById('copy-buffer');
      el.focus();
      el.select();
      document.execCommand('copy');
    }
  }
  function refreshImage(){
    if (!imageInput || !imagePreview) return;
    var url = imageInput.value.trim();
    imagePreview.innerHTML = url ? '<img src="' + url.replace(/"/g, '&quot;') + '" alt="发帖图片">' : '<div class="empty">这里显示准备发布的图片</div>';
    if (openImage) openImage.href = url || '#';
  }
  function refreshVideo(){
    if (!videoInput || !videoPreview) return;
    var url = videoInput.value.trim();
    videoPreview.innerHTML = url ? '<video src="' + url.replace(/"/g, '&quot;') + '" controls muted></video>' : '<div class="empty">这里显示准备发布的视频</div>';
    if (openVideo) openVideo.href = url || '#';
  }
  if (imageInput) imageInput.addEventListener('input', refreshImage);
  if (videoInput) videoInput.addEventListener('input', refreshVideo);
  document.querySelectorAll('.open-in-frame').forEach(function(button){
    button.addEventListener('click', function(){
      var frame = document.getElementById('facebook-frame');
      var url = button.getAttribute('data-url');
      if (frame && url) frame.src = url;
    });
  });
  document.querySelectorAll('.group-row[data-frame-url]').forEach(function(link){
    link.addEventListener('click', function(event){
      var frame = document.getElementById('facebook-frame');
      var url = link.getAttribute('data-frame-url');
      if (!frame || !url) return;
      event.preventDefault();
      frame.src = url;
      document.querySelectorAll('.group-row').forEach(function(row){ row.classList.remove('current'); });
      link.classList.add('current');
    });
  });
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
    current_group = None
    next_group = None
    try:
        selected_post = get_selected_post(request.args.get("post"))
        posts = get_promotion_posts()
        groups = get_promotion_groups()
        logs = get_group_logs(selected_post.get("id") if selected_post else None)
        log_by_group = group_log_map(logs)
        current_group = choose_current_group(groups, log_by_group, request.args.get("group"))
        next_group = next_group_after(groups, current_group)
    except Exception as error:
        setup_error = promotion_table_error(error)
        log_by_group = {}
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
        log_by_group=log_by_group,
        current_group=current_group,
        next_group=next_group,
    )


@app.post("/promotion/posts")
def promotion_post_submit():
    title = request.form.get("title", "").strip()
    content = request.form.get("content", "").strip()
    image_url = request.form.get("image_url", "").strip()
    video_url = request.form.get("video_url", "").strip()
    channel = request.form.get("channel", "facebook_group").strip()
    action = request.form.get("action", "draft").strip()
    if not content:
        return redirect("/promotion?success=0&message=Content%20is%20required", code=303)

    payload = {
        "title": title or content[:60],
        "content": content,
        "image_url": image_url,
        "video_url": video_url,
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
    next_group_id = request.form.get("next_group_id", "").strip()
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
        group_param = f"&group={next_group_id}" if next_group_id else ""
        return redirect(f"/promotion?success=1&message=Marked%20as%20posted{post_param}{group_param}", code=303)
    except Exception as error:
        return redirect(f"/promotion?success=0&message={quote(str(error)[:240])}", code=303)


install_navigation_links()
