# CRM 第一版配置清单

目标：把 Messenger 里询问过产品的客户自动保存到 CRM。

## 1. Supabase

新建一个 Supabase 项目，建议单独给 CRM 使用。

在 Supabase SQL Editor 里运行：

```text
schema.sql
```

Render 环境变量需要填写：

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
```

注意：`SUPABASE_SERVICE_ROLE_KEY` 只能放在 Render 后端环境变量里，不要放到前端网页里。

## 2. Render

新建 Web Service，连接 CRM 仓库。

启动命令：

```text
gunicorn app:app
```

健康检查地址：

```text
/health
```

上线后会得到类似这样的地址：

```text
https://crm-xxxx.onrender.com
```

## 3. Meta Messenger

需要准备：

```text
META_VERIFY_TOKEN
META_APP_SECRET
META_PAGE_ACCESS_TOKEN
META_PAGE_ID
```

Webhook Callback URL：

```text
https://你的CRM地址.onrender.com/webhooks/meta
```

Verify Token 填 `META_VERIFY_TOKEN` 里的同一个值。

订阅事件先选 Messenger 的 messages。

## 4. 当前版本能做什么

- 客户从 Messenger 发消息过来后，自动创建客户档案。
- 自动保存客户消息。
- 自动保存客户 Messenger 身份。
- 如果 Page Access Token 可用，会尝试读取客户公开资料，比如名字和头像。
- CRM 首页显示最近客户和最后消息。

## 5. 历史客户同步

Webhook 主要负责同步“接入以后”的新消息。

如果 Meta 权限允许，可以调用：

```text
POST /admin/import/messenger-conversations
```

它会尝试从 Page conversations API 拉取最近会话并导入 CRM。

注意：历史会话能导入多少，取决于 Meta 当前权限、Page 绑定状态、App Review、Page Access Token 权限范围。

## 6. 下一步

第一版跑通后，再做：

- 客户详情页
- CRM 内回复 Messenger
- Shopify 订单同步
- AI 回复草稿
- 自动标签和客户摘要
