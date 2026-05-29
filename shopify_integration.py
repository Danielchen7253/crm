"""Shopify Admin API integration for CRM business lookups."""

import os
import re

import requests
from flask import jsonify, render_template_string, request

import app_live_new

app = app_live_new.app
crm_module = app_live_new.crm_module

SHOPIFY_STORE_DOMAIN = os.getenv("SHOPIFY_STORE_DOMAIN", "").strip()
SHOPIFY_ADMIN_ACCESS_TOKEN = os.getenv("SHOPIFY_ADMIN_ACCESS_TOKEN", "").strip()
SHOPIFY_API_VERSION = os.getenv("SHOPIFY_API_VERSION", "2025-04").strip() or "2025-04"

ORIGINAL_OPENAI_REPLY_FOR = crm_module.openai_reply_for


def normalize_shopify_domain(value):
    domain = (value or "").strip()
    domain = domain.replace("https://", "").replace("http://", "").split("/")[0]
    if domain and "." not in domain:
        domain = f"{domain}.myshopify.com"
    return domain


def shopify_configured():
    return bool(normalize_shopify_domain(SHOPIFY_STORE_DOMAIN) and SHOPIFY_ADMIN_ACCESS_TOKEN)


def shopify_graphql(query, variables=None):
    if not shopify_configured():
        raise RuntimeError("Shopify is not configured.")
    domain = normalize_shopify_domain(SHOPIFY_STORE_DOMAIN)
    response = requests.post(
        f"https://{domain}/admin/api/{SHOPIFY_API_VERSION}/graphql.json",
        headers={
            "X-Shopify-Access-Token": SHOPIFY_ADMIN_ACCESS_TOKEN,
            "Content-Type": "application/json",
        },
        json={"query": query, "variables": variables or {}},
        timeout=25,
    )
    response.raise_for_status()
    payload = response.json()
    if payload.get("errors"):
        raise RuntimeError(payload["errors"][0].get("message", "Shopify GraphQL error"))
    return payload.get("data") or {}


def shopify_probe():
    items = [
        {
            "name": "Environment variables",
            "ok": shopify_configured(),
            "detail": "SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_ACCESS_TOKEN configured"
            if shopify_configured()
            else "missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_ACCESS_TOKEN",
        }
    ]
    if not shopify_configured():
        return {"ready": False, "items": items}

    probes = [
        (
            "Store connection",
            "query { shop { name myshopifyDomain } }",
            "can connect to Shopify Admin API",
        ),
        (
            "Products and inventory",
            "query { products(first: 1) { edges { node { id title variants(first: 1) { edges { node { id sku inventoryQuantity } } } } } } }",
            "can read products, SKUs and inventory quantity",
        ),
        (
            "Orders and fulfillment",
            "query { orders(first: 1, sortKey: CREATED_AT, reverse: true) { edges { node { id name displayFulfillmentStatus fulfillments(first: 5) { trackingInfo { number company url } } } } } }",
            "can read orders, fulfillment and tracking",
        ),
    ]
    for name, query, ok_detail in probes:
        try:
            data = shopify_graphql(query)
            items.append({"name": name, "ok": True, "detail": ok_detail, "data": data})
        except Exception as error:
            items.append({"name": name, "ok": False, "detail": str(error)})
    return {"ready": all(item["ok"] for item in items), "items": items}


def compact_variant(node):
    variants = []
    for edge in ((node.get("variants") or {}).get("edges") or []):
        variant = edge.get("node") or {}
        variants.append(
            {
                "id": variant.get("id"),
                "title": variant.get("title"),
                "sku": variant.get("sku"),
                "inventory_quantity": variant.get("inventoryQuantity"),
            }
        )
    return {
        "id": node.get("id"),
        "title": node.get("title"),
        "handle": node.get("handle"),
        "status": node.get("status"),
        "total_inventory": node.get("totalInventory"),
        "variants": variants,
    }


def search_shopify_inventory(query_text, limit=5):
    query_text = (query_text or "").strip()
    if not query_text:
        return []
    data = shopify_graphql(
        """
        query SearchInventory($query: String!, $limit: Int!) {
          products(first: $limit, query: $query) {
            edges {
              node {
                id
                title
                handle
                status
                totalInventory
                variants(first: 20) {
                  edges {
                    node {
                      id
                      title
                      sku
                      inventoryQuantity
                    }
                  }
                }
              }
            }
          }
        }
        """,
        {"query": query_text, "limit": limit},
    )
    return [compact_variant(edge.get("node") or {}) for edge in ((data.get("products") or {}).get("edges") or [])]


def search_shopify_orders(query_text, limit=5):
    query_text = (query_text or "").strip()
    if not query_text:
        return []
    data = shopify_graphql(
        """
        query SearchOrders($query: String!, $limit: Int!) {
          orders(first: $limit, query: $query, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id
                name
                createdAt
                displayFinancialStatus
                displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                customer { displayName email phone }
                fulfillments(first: 10) {
                  status
                  createdAt
                  deliveredAt
                  estimatedDeliveryAt
                  trackingInfo { number company url }
                }
                lineItems(first: 10) {
                  edges { node { title sku quantity } }
                }
              }
            }
          }
        }
        """,
        {"query": query_text, "limit": limit},
    )
    return [(edge.get("node") or {}) for edge in ((data.get("orders") or {}).get("edges") or [])]


def extract_shopify_terms(text):
    text = text or ""
    candidates = re.findall(r"[A-Za-z0-9][A-Za-z0-9._#-]{2,}", text)
    clean = []
    for item in candidates:
        lowered = item.lower().strip(".")
        if lowered in {"stock", "order", "tracking", "shipping", "delivery", "have", "available"}:
            continue
        clean.append(item.strip(".,;:!?"))
    return clean[:6]


def wants_inventory_lookup(text):
    lowered = (text or "").lower()
    keywords = ["stock", "inventory", "available", "in stock", "have", "有货", "库存", "还有", "现货"]
    return any(keyword in lowered for keyword in keywords)


def wants_order_lookup(text):
    lowered = (text or "").lower()
    keywords = ["order", "tracking", "track", "shipped", "delivered", "物流", "订单", "发货", "快递", "到哪"]
    return any(keyword in lowered for keyword in keywords)


def build_shopify_context(message_text):
    if not shopify_configured():
        return None
    terms = extract_shopify_terms(message_text)
    if not terms:
        return None
    context = {"terms": terms, "inventory": [], "orders": [], "errors": []}
    if wants_inventory_lookup(message_text):
        for term in terms[:3]:
            try:
                found = search_shopify_inventory(term, limit=3)
                if found:
                    context["inventory"].extend(found)
                    break
            except Exception as error:
                context["errors"].append(f"inventory: {error}")
                break
    if wants_order_lookup(message_text):
        for term in terms[:4]:
            try:
                found = search_shopify_orders(term, limit=3)
                if found:
                    context["orders"].extend(found)
                    break
            except Exception as error:
                context["errors"].append(f"orders: {error}")
                break
    return context if context["inventory"] or context["orders"] or context["errors"] else None


def openai_reply_with_shopify(customer, messages):
    latest_text = ""
    for message in reversed(messages):
        if message.get("direction") == "inbound":
            latest_text = message.get("text") or ""
            break
    shopify_context = build_shopify_context(latest_text)
    if not shopify_context:
        return ORIGINAL_OPENAI_REPLY_FOR(customer, messages)
    original_key = crm_module.OPENAI_API_KEY
    if not original_key:
        return {
            "source": "shopify_lookup",
            "category": "shopify_context",
            "confidence": 0.6,
            "draft_text": summarize_shopify_context(shopify_context),
        }

    prompt = {
        "customer_name": customer.get("display_name"),
        "conversation": crm_module.recent_conversation_text(messages),
        "shopify_live_context": shopify_context,
        "business_facts": [
            "Orders paid before 3 PM ship the same day.",
            "Orders paid after 3 PM ship the next business day.",
            "Holidays may delay shipping.",
            "Pickup address: 755 International Blvd, Houston, TX 77024.",
        ],
    }
    response = requests.post(
        "https://api.openai.com/v1/responses",
        headers={"Authorization": f"Bearer {original_key}", "Content-Type": "application/json"},
        json={
            "model": crm_module.OPENAI_MODEL,
            "input": [
                {
                    "role": "system",
                    "content": (
                        "Draft a short customer-service reply for a refrigerator gasket parts seller. "
                        "Use the Shopify live context when it contains inventory, order, fulfillment or tracking data. "
                        "Do not invent stock, purchase orders, delivery dates or tracking details. "
                        "If Shopify data is missing, say you will check and follow up. Return only the reply text."
                    ),
                },
                {"role": "user", "content": str(prompt)},
            ],
        },
        timeout=25,
    )
    response.raise_for_status()
    text = crm_module.parse_openai_text(response.json())
    if not text:
        return None
    return {"source": "openai+shopify", "category": "shopify_ai_draft", "confidence": 0.74, "draft_text": text}


def summarize_shopify_context(context):
    if context.get("inventory"):
        product = context["inventory"][0]
        variants = product.get("variants") or []
        lines = [f"{product.get('title')}: total inventory {product.get('total_inventory')}."]
        for variant in variants[:4]:
            lines.append(f"SKU {variant.get('sku') or '-'} has {variant.get('inventory_quantity')} available.")
        return "\n".join(lines)
    if context.get("orders"):
        order = context["orders"][0]
        tracking = []
        for fulfillment in order.get("fulfillments") or []:
            for info in fulfillment.get("trackingInfo") or []:
                tracking.append(f"{info.get('company') or ''} {info.get('number') or ''} {info.get('url') or ''}".strip())
        return (
            f"Order {order.get('name')} is {order.get('displayFulfillmentStatus')}. "
            f"Tracking: {', '.join(tracking) if tracking else 'not available yet'}."
        )
    return "I will check Shopify and follow up shortly."


def install_navigation_link():
    if "/admin/integrations" in app_live_new.TEMPLATE:
        return
    link = '<a class="nav-link" href="/admin/integrations"><span>接口整合</span><span class="nav-count">api</span></a>'
    settings_link = '<a class="nav-link" href="/settings"><span>&#31995;&#32479;&#35774;&#32622;</span><span class="nav-count">lock</span></a>'
    app_live_new.TEMPLATE = app_live_new.TEMPLATE.replace(settings_link, link + settings_link)


INTEGRATIONS_TEMPLATE = """
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>接口整合</title><style>
:root{font-family:Arial,"Microsoft YaHei",sans-serif;color:#17202a;background:#f4f6f8}*{box-sizing:border-box}body{margin:0}.top{height:58px;background:#16202a;color:#fff;display:flex;align-items:center;gap:12px;padding:0 16px}.back{color:#fff;text-decoration:none;font-weight:800}.wrap{max-width:1180px;margin:0 auto;padding:18px 16px;display:grid;gap:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.card{background:#fff;border:1px solid #d8dee8;border-radius:8px;padding:16px}h1{font-size:18px;margin:0}h2{font-size:16px;margin:0 0 10px}.muted{color:#6a7682;font-size:13px;line-height:1.45}.status{display:inline-flex;align-items:center;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:800}.ok{background:#eef7f4;color:#17634f}.bad{background:#fff2f0;color:#a8071a}.warn{background:#fff7e6;color:#ad6800}.rows{display:grid;gap:8px}.row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:start;border-top:1px solid #edf0f4;padding-top:8px}.code{font-family:Consolas,monospace;background:#f8fafb;border:1px solid #d8dee8;border-radius:8px;padding:10px;white-space:pre-wrap}.actions{display:flex;gap:10px;flex-wrap:wrap}.button{border:0;border-radius:8px;background:#1f8a70;color:#fff;font-weight:800;cursor:pointer;font-size:14px;padding:11px 14px;text-decoration:none}.secondary{background:#e8edf3;color:#17202a}@media(max-width:700px){.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr}.actions{display:grid}.button{width:100%;text-align:center}}
</style></head><body><header class="top"><a class="back" href="/">&lsaquo; CRM</a><h1>接口整合</h1></header><main class="wrap">
<section class="card"><h2>Shopify <span class="status {{ 'ok' if shopify.ready else 'warn' }}">{{ '已接入' if shopify.ready else '等待配置或权限' }}</span></h2>
<div class="rows">
{% for item in shopify['items'] %}<div class="row"><div><strong>{{ item.name }}</strong><div class="muted">{{ item.detail }}</div></div><span class="status {{ 'ok' if item.ok else 'bad' }}">{{ 'OK' if item.ok else '未通过' }}</span></div>{% endfor %}
</div></section>
<section class="grid">
<div class="card"><h2>Render 环境变量</h2><div class="muted">把 Shopify Custom App 的 Admin API token 放到 Render，不要写进代码。</div><div class="code">SHOPIFY_STORE_DOMAIN
SHOPIFY_ADMIN_ACCESS_TOKEN
SHOPIFY_API_VERSION</div></div>
<div class="card"><h2>CRM 内部查询接口</h2><div class="muted">AI 客服会用这些接口查业务数据，然后生成回复草稿。</div><div class="code">/api/shopify/status
/api/shopify/inventory?q=SKU_OR_PRODUCT
/api/shopify/orders?q=ORDER_OR_EMAIL_OR_PHONE</div></div>
</section>
<section class="card"><h2>AI 客服使用方式</h2><div class="muted">客户问库存、订单、发货、物流时，CRM 会先查 Shopify。查到数据后，AI 草稿会带上真实库存、订单状态和物流信息；查不到时不会乱编，会提示需要人工确认。</div></section>
</main></body></html>
"""


@app.get("/admin/integrations")
def integrations_page():
    return render_template_string(INTEGRATIONS_TEMPLATE, shopify=shopify_probe())


@app.get("/api/shopify/status")
def shopify_status_json():
    return jsonify({"ok": True, "shopify": shopify_probe()})


@app.get("/api/shopify/inventory")
def shopify_inventory_json():
    query_text = request.args.get("q", "").strip()
    if not query_text:
        return jsonify({"ok": False, "error": "q is required"}), 400
    try:
        return jsonify({"ok": True, "query": query_text, "products": search_shopify_inventory(query_text)})
    except Exception as error:
        return jsonify({"ok": False, "error": str(error)}), 502


@app.get("/api/shopify/orders")
def shopify_orders_json():
    query_text = request.args.get("q", "").strip()
    if not query_text:
        return jsonify({"ok": False, "error": "q is required"}), 400
    try:
        return jsonify({"ok": True, "query": query_text, "orders": search_shopify_orders(query_text)})
    except Exception as error:
        return jsonify({"ok": False, "error": str(error)}), 502


crm_module.openai_reply_for = openai_reply_with_shopify
install_navigation_link()
