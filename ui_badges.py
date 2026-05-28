"""Small UI patch for source badges in the live customer list."""

import app_live_new


BADGE_CSS = (
    ".customer-info{min-width:0;display:grid;gap:5px;width:100%;justify-self:stretch}"
    ".source-line{display:flex;align-items:center;gap:6px;min-width:0}"
    ".source-logo{display:inline-flex;align-items:center;justify-content:center;flex:none;"
    "width:22px;height:22px;border-radius:50%;overflow:hidden;background:#fff;border:1px solid #d8dee8}"
    ".source-logo img{width:100%;height:100%;object-fit:contain;display:block}"
    ".source-messenger{border-color:#cfe1ff}"
    ".source-whatsapp{border-color:#b7ebc6}"
    ".source-other{background:#6b7280}"
    ".last-line{display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:6px;min-width:0;width:100%}"
    ".last-preview{min-width:0;color:#6a7682;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
    ".last-time{color:#8a96a3;font-size:11px;white-space:nowrap;justify-self:end}"
)

TARGET_CSS = (
    ".customer-name,.rule-title{font-size:14px;font-weight:700;line-height:1.25;"
    "white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
)

CUSTOMER_ROW_PREFIX = (
    '<div class="avatar">{% if customer.profile_pic_url %}<img src="{{ customer.profile_pic_url }}" '
    'alt="">{% else %}{{ (customer.display_name or \'C\')[:1] }}{% endif %}</div>'
)

CUSTOMER_ROW_NEW = (
    CUSTOMER_ROW_PREFIX
    + '<div class="customer-info">'
    '<div class="customer-name">{{ customer.display_name or \'Customer\' }}</div>'
    '<div class="last-line">'
    '<span class="source-logo {% if customer.source == \'whatsapp\' %}source-whatsapp{% elif customer.source == \'messenger\' %}source-messenger{% else %}source-other{% endif %}" '
    'title="{{ customer.source }}">'
    "{% if customer.source == 'whatsapp' %}<img src=\"https://upload.wikimedia.org/wikipedia/commons/5/5e/WhatsApp_icon.png\" alt=\"WhatsApp\">{% elif customer.source == 'messenger' %}<img src=\"https://upload.wikimedia.org/wikipedia/commons/6/63/Facebook_Messenger_logo_2025.svg\" alt=\"Messenger\">{% else %}{{ (customer.source or '?')[:2]|upper }}{% endif %}"
    "</span>"
    '<span class="last-preview">{{ customer.last_message_preview or customer.source }}</span>'
    '<span class="last-time">{{ customer.last_message_time_short }}</span>'
    "</div>"
    "</div>"
)


def install_source_badges():
    template = app_live_new.TEMPLATE
    if "source-logo" not in template:
        template = template.replace(TARGET_CSS, TARGET_CSS + BADGE_CSS)
        start = template.find(CUSTOMER_ROW_PREFIX)
        if start != -1:
            end_marker = "</div></a>{% else %}"
            end = template.find(end_marker, start)
            if end != -1:
                template = template[:start] + CUSTOMER_ROW_NEW + template[end:]
        app_live_new.TEMPLATE = template


install_source_badges()
