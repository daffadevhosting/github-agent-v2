# GitHub Automation Agent v2

A Cloudflare Agent that automates GitHub operations through natural language chat (Indonesian & English) with PR, issue, and code review support.

## Features

- Intent detection (rule-based + AI fallback)
- Repo / branch / file / PR / issue automation
- AI code review
- Free / Pro / Team plans with usage limits
- Midtrans billing checkout + webhook activation
- BYOK external AI providers (Pro+)
- Collaboration rooms (Pro+)
- Pro Code Editor (Monaco fullscreen) — Pro/Team only; hard-gated on commit APIs
- Browser Lab (screenshot preview + E2E) via Cloudflare Browser Rendering — Pro/Team

## Production

- Webapp: https://github-agent.studiocode.workers.dev/
- Midtrans notification: https://github-agent.studiocode.workers.dev/api/billing/midtrans/webhook
- Billing return: https://github-agent.studiocode.workers.dev/?billing=success

```sh
npx wrangler secret put APP_URL
# https://github-agent.studiocode.workers.dev

npx wrangler secret put MIDTRANS_SERVER_KEY
npx wrangler secret put MIDTRANS_API_BASE
npx wrangler secret put AUTH_SECRET
npx wrangler secret put BYOK_ENCRYPTION_KEY
```

Apply D1 migrations:

```sh
npx wrangler d1 migrations apply github-agent-db --remote
```

## Local development

```sh
npm install
npm run dev
```

## Plans

| Plan | AI requests / 30d | Indexed repos | Extra |
|------|-------------------|---------------|-------|
| Free | 100 | 1 | Chat, GitHub, code search (file → chat only) |
| Pro | 5000 | 10 | Monaco editor, BYOK, collab, Browser Lab |
| Team | 25000 | 100 | All Pro features |

## Learn More

- https://developers.cloudflare.com/agents/
- https://developers.cloudflare.com/workers-ai/models/
