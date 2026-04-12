# nimmit-brain-api

Brain lesson aggregation API for Nimmit. Accepts lessons from Nimmit instances worldwide, creates PRs to `koompi/nimmit-brain`. Zero friction — no GitHub account needed.

**Live at:** https://brain.nimmit.xyz

## Why

Nimmit Brain users learn from their AI interactions. This API lets those lessons flow back to the community — automatically, privately, and without needing a GitHub account.

See [koompi/nimmit-brain](https://github.com/koompi/nimmit-brain) for the brain template.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Service info and endpoint list |
| `GET` | `/api/v1/brain/health` | Health check |
| `POST` | `/api/v1/brain/lessons` | Submit lessons |
| `GET` | `/api/v1/brain/lessons?since=2026-04-01` | Fetch recent community lessons |

## Submit Lessons

```bash
curl -X POST https://brain.nimmit.xyz/api/v1/brain/lessons \
  -H "Content-Type: application/json" \
  -d '{
    "brainVersion": "2.1.0",
    "lessons": [
      {
        "category": "procedural",
        "name": "Match User Language",
        "trigger": "User switches between languages mid-conversation",
        "lesson": "Detect the language of each message and respond in the same language. Don't ask — just switch.",
        "source": "Learned from bilingual user interactions"
      }
    ]
  }'
```

### Response (success)

```json
{
  "status": "accepted",
  "lessonsReceived": 1,
  "contribution": {
    "commitSha": "abc123...",
    "filesChanged": 1
  }
}
```

### Response (validation error)

```json
{
  "error": "Validation failed",
  "details": [
    "Lesson \"Personal Greeting\" appears to contain personal data. Generalize before submitting."
  ]
}
```

## Privacy

The API enforces privacy at the server level. Submissions containing personal data are rejected with 400.

| Blocked | Pattern |
|---------|---------|
| Emails | `user@example.com` |
| Phone numbers | `+855 12 345 678`, `091234567` |
| Internal URLs | `192.168.x.x`, `.local` |
| API keys/tokens | Long alphanumeric strings near "key"/"token"/"secret" |
| Personal names with context | `Mr. X said...`, `H.E. Y told...` |
| Telegram/user IDs | 9-10 digit numbers with user/chat context |

Lessons must be **generalized** before submission. The brain template handles this automatically.

## Lesson Schema

```typescript
interface Lesson {
  category: "procedural" | "semantic" | "workflow" | "anti-pattern";
  name: string;        // max 200 chars
  trigger: string;     // max 1000 chars — when does this apply?
  lesson: string;      // max 5000 chars — what should the agent do?
  source: string;      // max 500 chars — generic description, no personal data
}
```

### Categories

| Category | Description | Stored At |
|----------|-------------|-----------|
| `procedural` | How to do things better | `brain/memory/procedural/` |
| `semantic` | What things are (domain knowledge) | `brain/memory/semantic/` |
| `workflow` | Process and workflow improvements | `brain/memory/workflow/` |
| `anti-pattern` | Things to avoid | `brain/memory/failures/` |

## Rate Limits

- 10 requests per minute per IP
- 50 lessons per submission
- 5000 characters per lesson

## How It Works

```
Nimmit instance → POST /api/v1/brain/lessons
        │
        ▼
Validate (schema + privacy check)
        │
        ▼
Create GitHub branch → commit lesson files → create PR
        │
        ▼
KOOMPI Nimmit reviews PR weekly → merges or requests changes
        │
        ▼
Other Nimmit instances GET /api/v1/brain/lessons → pull updates
        │
        ▼
Everyone gets smarter
```

## Deploy

### Cloudflare Workers (recommended)

```bash
git clone https://github.com/koompi/nimmit-brain-api.git
cd nimmit-brain-api
bun install

# Set secrets
echo "production" | CLOUDFLARE_API_TOKEN=xxx bunx wrangler secret put ENVIRONMENT
echo "ghp_xxx" | CLOUDFLARE_API_TOKEN=xxx bunx wrangler secret put GITHUB_TOKEN

# Deploy
CLOUDFLARE_API_TOKEN=xxx bunx wrangler deploy

# Add custom domain in Cloudflare dashboard
# brain.nimmit.xyz → worker
```

### KOOMPI Cloud / Self-hosted

1. Set environment variables: `ENVIRONMENT=production`, `GITHUB_TOKEN=ghp_xxx`
2. Run: `bun run start`
3. Reverse proxy `brain.nimmit.xyz` → port 3000

### Local Dev

```bash
bun install
bun run dev
# API at http://localhost:3000
# ENVIRONMENT not set = dev mode (accepts lessons, no GitHub sync)
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ENVIRONMENT` | Yes | Must be `production` for GitHub sync |
| `GITHUB_TOKEN` | Yes | GitHub PAT with `repo` scope for `koompi/nimmit-brain` |
| `LESSON_WEBHOOK_SECRET` | No | Optional webhook secret for future use |

## Tech Stack

- [Hono](https://hono.dev) — fast web framework (works on Cloudflare Workers, Bun, Node)
- [Cloudflare Workers](https://workers.cloudflare.com) — serverless deployment
- [GitHub API](https://docs.github.com/rest) — PR creation and lesson fetching
- TypeScript strict

## License

Apache License 2.0 — see [LICENSE](LICENSE)
