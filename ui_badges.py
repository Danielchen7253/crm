"""Small UI patch for source badges in the live customer list."""

import app_live_new


BADGE_CSS = (
    ".customer-info{min-width:0;display:grid;gap:5px}"
    ".source-line{display:flex;align-items:center;gap:6px;min-width:0}"
    ".source-logo{display:inline-flex;align-items:center;justify-content:center;flex:none;"
    "width:24px;height:18px;border-radius:999px;color:#fff;font-size:10px;font-weight:800;line-height:1}"
    ".source-messenger{background:#0866ff}"
    ".source-whatsapp{background:#25d366;color:#0b351f}"
    ".source-other{background:#6b7280}"
)

TARGET_CSS = (
    ".customer-name,.rule-title{font-size:14px;font-weight:700;line-height:1.25;"
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
)

CUSTOMER_ROW_OLD = (
    '<div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" '
    'alt="">{% else %}{{ (customer.display_name or \'C\')[:1] }}{% endif %}</div>'
    '<div class="customer-name">{{ customer.display_name or \'\\u672a\\u547d\\u540d\\u5ba2\\u6237\' }}</div>'
)

CUSTOMER_ROW_NEW = (
    '<div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" '
    'alt="">{% else %}{{ (customer.display_name or \'C\')[:1] }}{% endif %}</div>'
    '<div class="customer-info">'
    '<div class="customer-name">{{ customer.display_name or \'\\u672a\\u547d\\u540d\\u5ba2\\u6237\' }}</div>'
    '<div class="source-line">'
    '<span class="source-logo {% if customer.source == \'whatsapp\' %}source-whatsapp{% elif customer.source == \'messenger\' %}source-messenger{% else %}source-other{% endif %}" '
    'title="{{ customer.source }}">'
    "{% if customer.source == 'whatsapp' %}WA{% elif customer.source == 'messenger' %}M{% else %}{{ (customer.source or '?')[:2]|upper }}{% endif %}"
    "</span>"
    '<span class="rule-meta">{{ customer.source }}</span>'
    "</div>"
    "</div>"
)


def install_source_badges():
    template = app_live_new.TEMPLATE
    if "source-logo" not in template:
        template = template.replace(TARGET_CSS, TARGET_CSS + BADGE_CSS)
        template = template.replace(CUSTOMER_ROW_OLD, CUSTOMER_ROW_NEW)
        app_live_new.TEMPLATE = template


install_source_badges()
