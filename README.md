# Kids AI Buzz 🚀

Real AI news scraped from 8 top tech sources, rewritten by Claude AI into kid-friendly language at 3 reading levels.

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment
```bash
cp .env.example .env
# Open .env and add your ANTHROPIC_API_KEY
```

### 3. Run
```bash
# Development (auto-restart on file change)
npm run dev

# Production
npm start
```

Open **http://localhost:3000** in your browser.

---

## How it works

```
Every 2 hours (configurable):
  ┌─────────────────────────────────────────────┐
  │  1. Scrape 8 RSS feeds in parallel          │
  │     VentureBeat, The Verge, TechCrunch,     │
  │     Ars Technica, Wired, IEEE Spectrum,     │
  │     AI News, Synced Review                  │
  │                                             │
  │  2. Deduplicate + sort newest-first         │
  │     Keep top 24 articles                    │
  │                                             │
  │  3. Send batches to Claude Sonnet           │
  │     Rewrite for 3 age levels:               │
  │       young  → Ages 6–8                     │
  │       middle → Ages 9–12                    │
  │       older  → Ages 13+                     │
  │                                             │
  │  4. Cache in memory                         │
  │     Frontend polls /api/news every 5 min    │
  └─────────────────────────────────────────────┘
```

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/news` | Get articles. Params: `level`, `category`, `limit` |
| `GET` | `/api/status` | Server health + cache info |
| `POST` | `/api/admin/refresh` | Force re-scrape (requires `x-admin-secret` header) |

**Example:**
```
GET /api/news?level=middle&category=robots&limit=6
```

---

## Deployment

### Render / Railway / Fly.io
1. Push to GitHub
2. Connect repo to your platform
3. Set environment variables from `.env.example`
4. Deploy — it auto-runs `npm start`

### VPS (Ubuntu)
```bash
npm install -g pm2
pm2 start server.js --name kids-ai-buzz
pm2 save && pm2 startup
```

### Nginx reverse proxy (optional)
```nginx
server {
    listen 80;
    server_name yourdomain.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Customise

- **Add more RSS feeds** → edit `RSS_FEEDS` array in `server.js`
- **Change refresh rate** → set `REFRESH_CRON` in `.env`
- **Add email newsletter** → wire `nlSignup()` in `public/index.html` to Mailchimp/Resend/ConvertKit
- **Add a database** → swap the in-memory `cache` object for SQLite or Postgres

---

## Stack

- **Backend:** Node.js + Express
- **Scraping:** rss-parser (8 feeds)
- **AI rewriting:** Anthropic Claude Sonnet
- **Caching:** in-memory (swap for Redis in production)
- **Scheduling:** node-cron
- **Security:** helmet, express-rate-limit, cors

