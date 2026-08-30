# GitHub Automation Agent v2

A Cloudflare Agent that automates GitHub operations through natural language chat (Indonesian & English) with PR, issue, and code review support.

## Features

- 🤖 **Intent detection** — rule-based + AI fallback (GPT-OSS 120B)
- 📦 **Repo management** — create repositories
- 🌿 **Branch operations** — create, delete, switch branches
- 📄 **File CRUD** — create, read, edit, delete files
- 🔀 **Pull Requests** — create, list, merge
- 📋 **Issues** — create, list, close, comment
- 🔍 **Code Review** — AI-powered review of PRs or individual files
- 🔒 **Cloudflare Access** — JWT authentication for your agent
- 🎨 **Minimal flat UI** — clean, modern, no gradients
- 💾 **State persistence** — remembers current repo & branch

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A Cloudflare account
- A GitHub Personal Access Token (with `repo` scope)

## Setup

### 1. Clone & install
```sh
# Use the clone command from the card
npm install
```

### 2. Set GitHub secrets
```sh
npx wrangler secret put GITHUB_TOKEN
# Paste your GitHub Personal Access Token

npx wrangler secret put GITHUB_OWNER
# Type your GitHub username
```

### 3. (Optional) Enable Cloudflare Access

For production authentication, set up Cloudflare Access:

```sh
npx wrangler secret put TEAM_DOMAIN
# e.g. https://your-team.cloudflareaccess.com

npx wrangler secret put POLICY_AUD
# Your Access application AUD tag
```

Then enable Access on your Worker:
1. Dashboard → Workers & Pages → your worker
2. Settings → Domains & Routes
3. Click **Enable Cloudflare Access**
4. Configure authorized emails in the Access policy

For local dev, the `wrangler.jsonc` already includes a dev Access identity.

### 4. Run locally
```sh
npm run dev
```

### 5. Deploy
```sh
npm run deploy
```

## Usage Examples

| Command | Action |
|---------|--------|
| `buat repo myproject` | Create a new repo |
| `buat branch feature dari main` | Create branch from main |
| `hapus branch old-feature` | Delete a branch |
| `switch branch develop` | Switch active branch |
| `buat file index.html` | Create a new file |
| `edit file app.js, tambahkan validasi` | Edit existing file |
| `baca file config.json` | Read file content |
| `hapus file old-script.js` | Delete a file |
| `list files` | List directory contents |
| `buat PR judul Fix bug dari feature ke main` | Create pull request |
| `list PR` | List pull requests |
| `merge PR #5` | Merge a pull request |
| `buat issue judul Login error` | Create an issue |
| `list issue` | List issues |
| `tutup issue #3` | Close an issue |
| `komentar issue #5: sudah diperbaiki` | Comment on issue |
| `review PR #5` | AI code review of PR |
| `review file app.js` | AI code review of file |
| `buat landing page` | Scaffold a web project |
| `help` | Show help |

## AI Model

This agent uses `@cf/openai/gpt-oss-120b` (OpenAI GPT-OSS 120B) via Workers AI.

Alternative models you can swap in `src/agent.ts` and `src/intent.ts`:

| Model | Context | Best for |
|-------|---------|----------|
| `@cf/openai/gpt-oss-120b` | 128K | General purpose, reasoning |
| `@cf/zai-org/glm-5.2` | 262K | Agentic coding |
| `@cf/moonshotai/kimi-k2.7-code` | 262K | Code generation |
| `@cf/nvidia/nemotron-3-120b-a12b` | 32K | Multi-agent workflows |
| `@cf/mistral-small-3.1-24b-instruct` | 128K | Balanced performance |

## Architecture

```
User (WebSocket) → Worker (Access JWT check) → Durable Object (GitHubAgent)
  ├─ Intent Detection (rule + AI)
  ├─ GitHub API Client (repos, branches, files, PRs, issues)
  └─ Workers AI (file generation, code review, commit messages, chat)
```

## Project Structure

```
├── src/
│   ├── index.ts      # Worker entry point + Access auth
│   ├── agent.ts      # Agent class (orchestration)
│   ├── intent.ts     # Intent detection (rule + AI)
│   ├── github.ts     # GitHub API client
│   ├── auth.ts       # Cloudflare Access JWT verification
│   └── types.ts      # TypeScript types
├── public/
│   └── index.html    # Flat minimal chat UI
├── wrangler.jsonc    # Wrangler config (AI, DO, Access dev)
└── package.json
```

## Learn More

- [Cloudflare Agents SDK](https://developers.cloudflare.com/agents/)
- [Workers AI Models](https://developers.cloudflare.com/workers-ai/models/)
- [Cloudflare Access for Workers](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
- [GitHub REST API](https://docs.github.com/en/rest)
