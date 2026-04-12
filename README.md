# nimmit-brain-api

Brain lesson aggregation API for Nimmit. Accepts lessons from Nimmit instances worldwide, creates PRs to `koompi/nimmit-brain`. Zero friction — no GitHub account needed.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Service info |
| `GET` | `/api/v1/brain/health` | Health check |
| `POST` | `/api/v1/brain/lessons` | Submit lessons |
| `GET` | `/api/v1/brain/lessons?since=2026-04-01` | Fetch recent lessons |

## Submit Lessons

```bash
curl -X POST https://nimmit.koompi.ai/api/v1/brain/lessons \
  -H "Content-Type: application/json" \
  -d '{
    "brainVersion": "2.0.0",
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

### Response

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

## Privacy

The API enforces privacy at the server level:

- **Emails** — rejected
- **Phone numbers** — rejected (Cambodian + international formats)
- **Internal URLs** — rejected (192.168.x, .local)
- **API keys/tokens** — rejected
- **Personal names with context** — rejected
- **Telegram/user IDs** — rejected

Submissions with personal data return 400 with details.

## Lesson Categories

| Category | Description | Stored At |
|----------|-------------|-----------|
| `procedural` | How to do things | `brain/memory/procedural/` |
| `semantic` | What things are | `brain/memory/semantic/` |
| `workflow` | Process improvements | `brain/memory/workflow/` |
| `anti-pattern` | Things to avoid | `brain/memory/failures/` |

## Rate Limits

- 10 requests per minute per IP
- 50 lessons per submission
- 5000 chars per lesson

## Deploy to Cloudflare Workers

```bash
# Install deps
bun install

# Set secrets
bunx wrangler secret put GITHUB_TOKEN
bunx wrangler secret put LESSON_WEBHOOK_SECRET

# Deploy
bun run deploy:cf
```

## Deploy to KOOMPI Cloud

1. Set env vars: `GITHUB_TOKEN`, `LESSON_WEBHOOK_SECRET`
2. Run as a Bun service behind Caddy/Nginx reverse proxy
3. Route `nimmit.koompi.ai` → this service

## Local Dev

```bash
bun run dev
# API at http://localhost:3000
```

## How It Works

```
Nimmit instance → POST /api/v1/brain/lessons
    ↓
Validate (schema + privacy check)
    ↓
Create GitHub branch → commit lesson files → create PR
    ↓
Nimmit reviews PR weekly → merges or requests changes
    ↓
Other Nimmit instances GET /api/v1/brain/lessons → pull updates
```
