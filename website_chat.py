"""Embeddable website chat for Shopify and product sites."""

import base64
import mimetypes
import re
import uuid
from datetime import datetime, timezone

import requests
from flask import Response, jsonify, request

import app_live_new
import shopify_integration


app = app_live_new.app
crm_module = app_live_new.crm_module

PROVIDER = "website"
MAX_UPLOAD_BYTES = 3 * 1024 * 1024


def cors_response(payload, status=200):
    response = jsonify(payload)
    response.status_code = status
    add_cors_headers(response)
    return response


def add_cors_headers(response):
    response.headers["Access-Control-Allow-Origin"] = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, X-Coolfix-Chat"
    response.headers["Access-Control-Max-Age"] = "86400"
    return response


def preflight():
    response = Response("", status=204)
    return add_cors_headers(response)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def clean_text(value, limit=4000):
    return (value or "").strip()[:limit]


def normalize_email(value):
    return clean_text(value, 320).lower()


def normalize_phone(value):
    digits = re.sub(r"\D+", "", value or "")
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    return digits


def visitor_name(contact):
    name = clean_text(contact.get("name"), 120)
    if name:
        return name
    email = normalize_email(contact.get("email"))
    if email:
        return email
    phone = normalize_phone(contact.get("phone"))
    if phone:
        return phone
    return None


def detect_language(text):
    text = text or ""
    if re.search(r"[\u4e00-\u9fff]", text):
        return "zh"
    if re.search(r"[¿¡ñáéíóú]", text.lower()):
        return "es"
    return "en"


def same_language_instruction(language):
    if language == "zh":
        return "Reply in Simplified Chinese."
    if language == "es":
        return "Reply in Spanish."
    return "Reply in the same language as the customer's latest message."


def localized_text(key, language):
    zh = {
        "verify": "订单、物流、保修、地址、付款等个人信息需要先验证身份。请输入订单号，以及下单时使用的邮箱或手机号。",
        "human": "我现在无法访问订单系统，会让工作人员帮你核实。",
        "verify_failed": "订单号和邮箱/手机号没有匹配成功。请检查后再发一次，或等待人工客服处理。",
        "inventory_detail": "我可以帮你查库存。请发送产品名称、SKU、型号，或上传清晰照片。",
        "photo_request": "请上传清晰的型号铭牌照片、配件照片和尺寸照片。我会先确认适配后再报价。",
        "fallback": "收到，我会尽快帮你确认。",
        "pickup": "提货地址：755 International Blvd, Houston, TX 77024。",
        "shipping": "下午3点前付款的订单当天发货；下午3点后付款的订单下一个工作日发货；节假日顺延。",
    }
    en = {
        "verify": "For order, tracking, warranty, address, or payment questions, please enter your order number plus the email or phone number used on the order.",
        "human": "I could not access the order system right now. I will have a team member check this for you.",
        "verify_failed": "I could not match that order with the email or phone provided. Please check the details or wait for a team member to help.",
        "inventory_detail": "I can check inventory for you. Please send the product name, SKU, model number, or a clear photo.",
        "photo_request": "Please upload a clear model tag photo, a photo of the part, and any size measurements. I will check compatibility before quoting.",
        "fallback": "Thanks. I received your message and will check it shortly.",
        "pickup": "Pickup address: 755 International Blvd, Houston, TX 77024.",
        "shipping": "Orders paid before 3 PM ship the same day. Orders paid after 3 PM ship the next business day. Holidays may delay shipping.",
    }
    return (zh if language == "zh" else en).get(key, en.get(key, ""))


def temporary_avatar_data_url(label, color="#1f8a70"):
    label = clean_text(label, 2).upper() or "G"
    svg = (
        f"<svg xmlns='http://www.w3.org/2000/svg' width='96' height='96'>"
        f"<rect width='96' height='96' rx='48' fill='{color}'/>"
        f"<text x='48' y='58' text-anchor='middle' font-family='Arial' font-size='34' font-weight='700' fill='white'>{label}</text>"
        f"</svg>"
    )
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")


def contact_initial(contact, session_id):
    name = visitor_name(contact) or session_id[-1:] or "G"
    match = re.search(r"[A-Za-z0-9\u4e00-\u9fff]", name)
    return match.group(0) if match else "G"


def find_identity(session_id):
    rows = crm_module.sb_get(
        "customer_identities",
        {
            "provider": f"eq.{PROVIDER}",
            "provider_user_id": f"eq.{session_id}",
            "select": "customer_id",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


def ensure_website_customer(session_id, contact=None, context=None):
    contact = contact or {}
    context = context or {}
    identity = find_identity(session_id)
    display_name = visitor_name(contact)
    metadata = {
        "website_session_id": session_id,
        "contact": {
            "name": clean_text(contact.get("name"), 120),
            "email": normalize_email(contact.get("email")),
            "phone": normalize_phone(contact.get("phone")),
        },
        "page": {
            "url": clean_text(context.get("page_url"), 1000),
            "title": clean_text(context.get("page_title"), 300),
            "referrer": clean_text(context.get("referrer"), 1000),
        },
        "verified_order": context.get("verified_order") or None,
    }
    payload = {
        "source": "website",
        "last_seen_at": now_iso(),
        "metadata": metadata,
    }
    if display_name:
        payload["display_name"] = display_name
    if identity:
        crm_module.sb_patch("customers", payload, {"id": f"eq.{identity['customer_id']}"})
        return identity["customer_id"], False
    customer = crm_module.sb_post(
        "customers",
        {
            "display_name": display_name or f"Website Visitor {session_id[-6:]}",
            "source": "website",
            "first_seen_at": now_iso(),
            "last_seen_at": now_iso(),
            "profile_pic_url": temporary_avatar_data_url(contact_initial(contact, session_id)),
            "tags": ["网站客服"],
            "metadata": metadata,
        },
    )[0]
    crm_module.sb_post(
        "customer_identities",
        {
            "customer_id": customer["id"],
            "provider": PROVIDER,
            "provider_user_id": session_id,
            "display_name": customer.get("display_name"),
            "raw_profile": metadata,
        },
    )
    return customer["id"], True


def save_website_message(customer_id, direction, text, attachments=None, raw=None):
    message = crm_module.sb_post(
        "messages",
        {
            "customer_id": customer_id,
            "provider": PROVIDER,
            "provider_message_id": f"web_{uuid.uuid4().hex}",
            "direction": direction,
            "message_type": "attachment" if attachments and not text else "text",
            "text": text or None,
            "attachments": attachments or [],
            "raw_event": raw or {},
            "sent_at": now_iso(),
        },
    )[0]
    crm_module.sb_patch(
        "customers",
        {"last_seen_at": now_iso(), "last_message_at": message["sent_at"]},
        {"id": f"eq.{customer_id}"},
    )
    return message


def is_order_or_private_question(text):
    lowered = (text or "").lower()
    public_address_phrases = ["pickup address", "pickup location", "warehouse address", "where can i pick", "提货地址", "自取地址", "仓库地址"]
    if any(phrase in lowered for phrase in public_address_phrases):
        return False
    keywords = [
        "order",
        "tracking",
        "track",
        "refund",
        "return",
        "warranty",
        "address",
        "payment",
        "paid",
        "delivered",
        "shipped",
        "where is my",
        "订单",
        "物流",
        "地址",
        "付款",
        "退款",
        "保修",
        "售后",
    ]
    return any(keyword in lowered for keyword in keywords)


def is_inventory_question(text):
    lowered = (text or "").lower()
    keywords = ["stock", "inventory", "in stock", "available", "have", "sku", "库存", "有货", "现货"]
    return any(keyword in lowered for keyword in keywords)


def extract_terms(text):
    return [term.strip(".,;:!?") for term in re.findall(r"[A-Za-z0-9][A-Za-z0-9._#/-]{2,}", text or "")][:5]


def compact_inventory_reply(items, language="en"):
    if not items:
        return localized_text("inventory_detail", language)
    lines = ["我查到的库存：" if language == "zh" else "Here is what I found in inventory:"]
    for item in items[:3]:
        title = item.get("title") or "Product"
        total = item.get("total_inventory")
        if total is None:
            total = "unknown"
        lines.append(f"- {title}: {'总库存' if language == 'zh' else 'total inventory'} {total}")
        for variant in (item.get("variants") or [])[:4]:
            sku = variant.get("sku") or variant.get("title") or "variant"
            qty = variant.get("inventory_quantity")
            lines.append(f"  {sku}: {qty if qty is not None else 'unknown'}")
    lines.append("如果是适配问题，请先确认准确型号或上传照片。" if language == "zh" else "Please confirm the exact model/photo before purchase if this is a fitment question.")
    return "\n".join(lines)


def order_matches_contact(order, email, phone):
    customer = order.get("customer") or {}
    order_email = normalize_email(customer.get("email"))
    order_phone = normalize_phone(customer.get("phone"))
    return bool((email and email == order_email) or (phone and phone == order_phone))


def compact_order_reply(order, language="en"):
    tracking = []
    for fulfillment in order.get("fulfillments") or []:
        for item in fulfillment.get("trackingInfo") or []:
            number = item.get("number") or ""
            company = item.get("company") or ""
            url = item.get("url") or ""
            tracking.append(" ".join(part for part in [company, number, url] if part))
    if language == "zh":
        lines = [
            f"订单 {order.get('name')}：",
            f"付款状态：{order.get('displayFinancialStatus') or 'unknown'}",
            f"发货状态：{order.get('displayFulfillmentStatus') or 'unknown'}",
        ]
    else:
        lines = [
            f"Order {order.get('name')}:",
            f"Payment: {order.get('displayFinancialStatus') or 'unknown'}",
            f"Fulfillment: {order.get('displayFulfillmentStatus') or 'unknown'}",
        ]
    if tracking:
        lines.append(("物流信息：" if language == "zh" else "Tracking: ") + "; ".join(tracking[:3]))
    else:
        lines.append("暂时还没有物流单号。" if language == "zh" else "Tracking is not available yet.")
    return "\n".join(lines)


def fixed_reply(text, language="en"):
    draft = crm_module.fixed_reply_for(text)
    if draft and draft.get("draft_text"):
        lowered = draft["draft_text"].lower()
        if "pickup address" in lowered:
            return localized_text("pickup", language)
        if "ship" in lowered or "orders paid" in lowered:
            return localized_text("shipping", language)
        return draft["draft_text"]
    return None


def website_openai_reply(message_text, contact, language):
    if not crm_module.OPENAI_API_KEY:
        return None
    prompt = {
        "customer_name": visitor_name(contact) or "Website visitor",
        "latest_message": message_text,
        "business_rules": [
            "Do not reveal order, tracking, warranty, payment, address, or purchase-history information unless the user has verified with order number plus email or phone.",
            "For model, photo, size, and compatibility questions, ask for clear model tag photo, part photo, and measurements.",
            "Pickup address: 755 International Blvd, Houston, TX 77024.",
            "Orders paid before 3 PM ship the same day. Orders paid after 3 PM ship the next business day. Holidays may delay shipping.",
        ],
    }
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers={"Authorization": f"Bearer {crm_module.OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": crm_module.OPENAI_MODEL,
            "input": [
                {
                    "role": "system",
                    "content": (
                        "You are a concise website customer-service assistant for Coolfix Pro Supply. "
                        f"{same_language_instruction(language)} "
                        "Be practical and direct. Do not invent inventory, price, compatibility, shipping, or private order details."
                    ),
                },
                {"role": "user", "content": str(prompt)},
            ],
        },
        timeout=25,
    )
    response.raise_for_status()
    text = crm_module.parse_openai_text(response.json())
    return text or None


def safe_website_reply(message_text, contact):
    message_text = clean_text(message_text)
    language = detect_language(message_text)
    if is_order_or_private_question(message_text):
        order_number = clean_text(contact.get("order_number"), 80)
        email = normalize_email(contact.get("email"))
        phone = normalize_phone(contact.get("phone"))
        if not order_number or not (email or phone):
            return {
                "kind": "needs_verification",
                "text": localized_text("verify", language),
            }
        try:
            orders = shopify_integration.search_shopify_orders(order_number, limit=5)
        except Exception:
            return {"kind": "needs_human", "text": localized_text("human", language)}
        for order in orders:
            if order_matches_contact(order, email, phone):
                return {"kind": "verified_order", "text": compact_order_reply(order, language), "verified_order": order.get("name")}
        return {
            "kind": "verification_failed",
            "text": localized_text("verify_failed", language),
        }

    canned = fixed_reply(message_text, language)
    if canned:
        return {"kind": "fixed", "text": canned}

    if is_inventory_question(message_text):
        for term in extract_terms(message_text):
            try:
                items = shopify_integration.search_shopify_inventory(term, limit=3)
            except Exception:
                items = []
            if items:
                return {"kind": "inventory", "text": compact_inventory_reply(items, language)}
        return {"kind": "inventory_needs_detail", "text": compact_inventory_reply([], language)}

    if crm_module.should_learn_without_draft({"text": message_text, "attachments": []}):
        return {
            "kind": "photo_request",
            "text": localized_text("photo_request", language),
        }

    try:
        draft = website_openai_reply(message_text, contact, language)
        if draft:
            return {"kind": "ai_draft", "text": draft}
    except requests.RequestException:
        pass
    return {"kind": "fallback", "text": localized_text("fallback", language)}


@app.after_request
def add_widget_cors(response):
    if request.path.startswith("/api/chat/") or request.path == "/chat/widget.js":
        add_cors_headers(response)
    return response


@app.route("/api/chat/session", methods=["POST", "OPTIONS"])
def chat_session():
    if request.method == "OPTIONS":
        return preflight()
    payload = request.get_json(silent=True) or {}
    session_id = clean_text(payload.get("session_id"), 80) or f"web_{uuid.uuid4().hex}"
    contact = payload.get("contact") or {}
    context = payload.get("context") or {}
    customer_id, created = ensure_website_customer(session_id, contact, context)
    return cors_response({"ok": True, "session_id": session_id, "customer_id": customer_id, "created": created})


@app.route("/api/chat/messages", methods=["POST", "OPTIONS"])
def chat_messages():
    if request.method == "OPTIONS":
        return preflight()
    payload = request.get_json(silent=True) or {}
    session_id = clean_text(payload.get("session_id"), 80) or f"web_{uuid.uuid4().hex}"
    contact = payload.get("contact") or {}
    context = payload.get("context") or {}
    text = clean_text(payload.get("text"), 4000)
    attachments = payload.get("attachments") or []
    if not text and not attachments:
        return cors_response({"ok": False, "error": "message is empty"}, status=400)
    customer_id, _ = ensure_website_customer(session_id, contact, context)
    inbound = save_website_message(customer_id, "inbound", text, attachments, {"source": "website_widget", "context": context, "contact": contact})
    reply = safe_website_reply(text, contact)
    outbound = save_website_message(customer_id, "outbound", reply["text"], [], {"source": "website_widget_ai", "kind": reply["kind"]})
    return cors_response(
        {
            "ok": True,
            "session_id": session_id,
            "customer_id": customer_id,
            "message": inbound,
            "reply": {"id": outbound["id"], "text": reply["text"], "kind": reply["kind"]},
        }
    )


@app.route("/api/chat/upload", methods=["POST", "OPTIONS"])
def chat_upload():
    if request.method == "OPTIONS":
        return preflight()
    file = request.files.get("file")
    if not file:
        return cors_response({"ok": False, "error": "file is required"}, status=400)
    data = file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        return cors_response({"ok": False, "error": "file is too large; max 3 MB"}, status=400)
    content_type = file.content_type or mimetypes.guess_type(file.filename or "")[0] or "application/octet-stream"
    encoded = base64.b64encode(data).decode("ascii")
    data_url = f"data:{content_type};base64,{encoded}"
    return cors_response(
        {
            "ok": True,
            "attachment": {
                "type": "image" if content_type.startswith("image/") else "file",
                "url": data_url,
                "name": clean_text(file.filename, 180) or "upload",
                "content_type": content_type,
                "size": len(data),
            },
        }
    )


@app.get("/chat/widget.js")
def chat_widget_js():
    script = r"""
(function(){
  if (window.CoolfixChatLoaded) return;
  window.CoolfixChatLoaded = true;
  const API = new URL(document.currentScript.src).origin;
  const sessionKey = 'coolfix_chat_session_id';
  const sid = localStorage.getItem(sessionKey) || ('web_' + Math.random().toString(16).slice(2) + Date.now().toString(16));
  localStorage.setItem(sessionKey, sid);
  const context = () => ({ page_url: location.href, page_title: document.title, referrer: document.referrer });
  const style = document.createElement('style');
  style.textContent = `
    .cfx-chat-button{position:fixed;right:18px;bottom:18px;z-index:2147483647;border:0;border-radius:999px;background:#1f8a70;color:#fff;width:58px;height:58px;font:700 15px Arial;box-shadow:0 14px 34px rgba(15,23,42,.28);cursor:pointer}
    .cfx-chat{position:fixed;right:18px;bottom:88px;z-index:2147483647;width:min(380px,calc(100vw - 24px));height:min(620px,calc(100vh - 110px));background:#fff;border:1px solid #d8dee8;border-radius:10px;box-shadow:0 18px 50px rgba(15,23,42,.25);display:none;overflow:hidden;font-family:Arial,sans-serif;color:#17202a}
    .cfx-chat.open{display:flex;flex-direction:column}.cfx-head{background:#16202a;color:#fff;padding:13px 14px;font-weight:800;display:flex;justify-content:space-between;align-items:center}.cfx-close{background:transparent;color:#fff;border:0;font-size:20px;cursor:pointer}
    .cfx-body{flex:1;overflow:auto;background:#f4f6f8;padding:12px;display:flex;flex-direction:column;gap:8px}.cfx-row{display:flex;gap:8px;align-items:flex-end;max-width:94%}.cfx-row.me{align-self:flex-end;flex-direction:row-reverse}.cfx-row.bot{align-self:flex-start}.cfx-avatar{width:30px;height:30px;border-radius:50%;background:#1f8a70;color:#fff;display:flex;align-items:center;justify-content:center;font:800 12px Arial;flex:none;overflow:hidden}.cfx-row.me .cfx-avatar{background:#2563eb}.cfx-msg{border:1px solid #d8dee8;border-radius:8px;background:#fff;padding:9px 11px;font-size:14px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}.cfx-row.me .cfx-msg{background:#eaf2ff}.cfx-row.bot .cfx-msg{background:#fff}
    .cfx-form{border-top:1px solid #d8dee8;padding:10px;background:#fff;display:grid;gap:8px}.cfx-fields{display:grid;grid-template-columns:1fr 1fr;gap:7px}.cfx-fields input,.cfx-form textarea{width:100%;border:1px solid #cfd7e2;border-radius:8px;padding:8px;font:13px Arial}.cfx-form textarea{min-height:64px;resize:vertical}.cfx-actions{display:flex;gap:8px}.cfx-actions button,.cfx-upload{border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:800;padding:9px 11px;cursor:pointer;text-align:center;font-size:13px}.cfx-upload{background:#e8edf3;color:#17202a}.cfx-upload input{display:none}.cfx-hint{font-size:12px;color:#6a7682}.cfx-file{font-size:12px;color:#17634f}
    @media(max-width:520px){.cfx-chat{right:0;left:0;bottom:0;width:100vw;height:82vh;border-radius:12px 12px 0 0}.cfx-chat-button{right:14px;bottom:14px}.cfx-fields{grid-template-columns:1fr}}
  `;
  document.head.appendChild(style);
  const button = document.createElement('button');
  button.className = 'cfx-chat-button';
  button.textContent = 'Chat';
  const panel = document.createElement('section');
  panel.className = 'cfx-chat';
  panel.innerHTML = `
    <div class="cfx-head"><span>Coolfix Support</span><button class="cfx-close" aria-label="Close">×</button></div>
    <div class="cfx-body"><div class="cfx-row bot"><div class="cfx-avatar">CF</div><div class="cfx-msg">Hi, how can I help? You can ask general questions anonymously. For order, tracking, warranty, payment, or address questions, please enter order number plus email or phone.</div></div></div>
    <form class="cfx-form">
      <div class="cfx-fields"><input name="name" placeholder="Name"><input name="phone" placeholder="Phone"></div>
      <div class="cfx-fields"><input name="email" placeholder="Email"><input name="order_number" placeholder="Order # for private info"></div>
      <textarea name="text" placeholder="Ask a question or describe the part you need"></textarea>
      <div class="cfx-file"></div>
      <div class="cfx-actions"><label class="cfx-upload">Upload photo<input name="file" type="file" accept="image/*"></label><button type="submit">Send</button></div>
      <div class="cfx-hint">Photos, model tags, and measurements help us quote correctly.</div>
    </form>`;
  document.body.appendChild(button); document.body.appendChild(panel);
  const body = panel.querySelector('.cfx-body');
  const form = panel.querySelector('form');
  const fileInput = form.querySelector('input[type=file]');
  const fileLabel = panel.querySelector('.cfx-file');
  let attachments = [];
  function customerInitial(){ const raw=(form.name.value || form.email.value || form.phone.value || 'G').trim(); const m=raw.match(/[A-Za-z0-9\u4e00-\u9fff]/); return (m ? m[0] : 'G').toUpperCase(); }
  function addMsg(text, cls){
    const row=document.createElement('div'); row.className='cfx-row '+cls;
    const avatar=document.createElement('div'); avatar.className='cfx-avatar'; avatar.textContent = cls === 'me' ? customerInitial() : 'CF';
    const bubble=document.createElement('div'); bubble.className='cfx-msg'; bubble.textContent=text;
    row.appendChild(avatar); row.appendChild(bubble); body.appendChild(row); body.scrollTop=body.scrollHeight;
  }
  function contact(){ return { name: form.name.value, phone: form.phone.value, email: form.email.value, order_number: form.order_number.value }; }
  async function ensureSession(){ await fetch(API + '/api/chat/session', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({session_id:sid, contact:contact(), context:context()})}); }
  button.onclick = async () => { panel.classList.add('open'); await ensureSession(); };
  panel.querySelector('.cfx-close').onclick = () => panel.classList.remove('open');
  fileInput.onchange = async () => {
    const file = fileInput.files && fileInput.files[0]; if(!file) return;
    fileLabel.textContent = 'Uploading ' + file.name + '...';
    const fd = new FormData(); fd.append('file', file);
    const res = await fetch(API + '/api/chat/upload', {method:'POST', body:fd});
    const json = await res.json();
    if(json.ok){ attachments.push(json.attachment); fileLabel.textContent = 'Attached: ' + file.name; } else { fileLabel.textContent = json.error || 'Upload failed'; }
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const text = form.text.value.trim();
    if(!text && !attachments.length) return;
    addMsg(text || '[photo uploaded]', 'me');
    form.text.value = '';
    const sendingAttachments = attachments; attachments = []; fileInput.value = ''; fileLabel.textContent = '';
    try {
      const res = await fetch(API + '/api/chat/messages', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({session_id:sid, contact:contact(), context:context(), text:text, attachments:sendingAttachments})});
      const json = await res.json();
      addMsg((json.reply && json.reply.text) || 'Received. We will check shortly.', 'bot');
    } catch(e) { addMsg('Network error. Please try again or call us.', 'bot'); }
  };
})();"""
    response = Response(script, mimetype="application/javascript")
    response.headers["Cache-Control"] = "public, max-age=300"
    return add_cors_headers(response)


@app.get("/chat/demo")
def chat_demo():
    html = """
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Coolfix Chat Demo</title></head>
<body style="font-family:Arial,sans-serif;margin:40px"><h1>Coolfix Chat Demo</h1><p>This page shows the website chat widget.</p><script src="/chat/widget.js"></script></body></html>
"""
    return Response(html, mimetype="text/html")
