require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const compression  = require('compression');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const cron         = require('node-cron');
const RSSParser    = require('rss-parser');
const Anthropic    = require('@anthropic-ai/sdk');
const path         = require('path');

/* ═══════════════════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════════════════ */
const PORT         = process.env.PORT         || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'changeme';
const REFRESH_CRON = process.env.REFRESH_CRON || '0 */2 * * *';
const NODE_ENV     = process.env.NODE_ENV     || 'development';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('❌  ANTHROPIC_API_KEY not set. Copy .env.example → .env and add your key.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const parser    = new RSSParser({
  timeout: 8000,
  headers: { 'User-Agent': 'KidsAIBuzz/1.0 RSS Reader' },
  customFields: { item: [['media:content','mediaContent'],['content:encoded','contentEncoded']] }
});

/* ═══════════════════════════════════════════════════════════
   RSS FEED LIST  (AI / tech focused)
═══════════════════════════════════════════════════════════ */
const RSS_FEEDS = [
  { url: 'https://venturebeat.com/category/ai/feed/',                           source: 'VentureBeat'    },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',   source: 'The Verge'      },
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/',       source: 'TechCrunch'     },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',            source: 'Ars Technica'   },
  { url: 'https://www.wired.com/feed/tag/ai/latest/rss',                        source: 'Wired'          },
  { url: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss',   source: 'IEEE Spectrum'  },
  { url: 'https://www.artificialintelligence-news.com/feed/',                   source: 'AI News'        },
  { url: 'https://syncedreview.com/feed/',                                      source: 'Synced Review'  },
];

/* ═══════════════════════════════════════════════════════════
   CATEGORY KEYWORD MAP
═══════════════════════════════════════════════════════════ */
const CATEGORY_KEYWORDS = {
  robots:  ['robot','robotic','drone','autonomous vehicle','humanoid','boston dynamics','mechanical arm','warehouse robot','delivery robot'],
  art:     ['dall-e','midjourney','stable diffusion','image generation','generative art','creative ai','ai music','suno','udio','video generation','runway','sora'],
  gaming:  ['game','gaming','video game','minecraft','fortnite','esport','npc','unity engine','unreal engine','game dev'],
  animals: ['animal','wildlife','species','ecology','biology','nature','ocean','bird','whale','endangered','conservation','pet'],
  space:   ['space','nasa','astronaut','planet','satellite','telescope','mars','rocket','astronomy','cosmos','exoplanet','james webb'],
  science: ['research','study','discovery','medical','health','brain','climate','quantum','physics','chemistry','cancer','drug','hospital','diagnosis'],
  cool:    ['chatgpt','gpt-4','gemini','claude ai','llm','language model','breakthrough','chip','nvidia','openai','deepmind','anthropic','meta ai'],
};

function detectCategory(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kws.some(kw => text.includes(kw))) return cat;
  }
  return 'cool';
}

/* ═══════════════════════════════════════════════════════════
   IN-MEMORY CACHE
═══════════════════════════════════════════════════════════ */
const cache = {
  articles:    [],
  lastUpdated: null,
  isRefreshing: false,
};

/* ═══════════════════════════════════════════════════════════
   STEP 1 — SCRAPE RSS FEEDS
═══════════════════════════════════════════════════════════ */
async function scrapeFeed(feed) {
  try {
    const result = await parser.parseURL(feed.url);
    return (result.items || []).slice(0, 10).map(item => ({
      title:   (item.title || '').replace(/&amp;/g,'&').replace(/&#8217;/g,"'").trim(),
      summary: (item.contentSnippet || item.description || '').replace(/<[^>]+>/g,'').slice(0, 500).trim(),
      link:    item.link || '',
      pubDate: item.pubDate || item.isoDate || new Date().toISOString(),
      source:  feed.source,
    }));
  } catch (err) {
    console.warn(`  ⚠  ${feed.source}: ${err.message}`);
    return [];
  }
}

async function scrapeAllFeeds() {
  console.log('📡 Scraping feeds...');
  const settled = await Promise.allSettled(RSS_FEEDS.map(scrapeFeed));
  const all = settled
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(a => a.title && a.title.length > 15);

  // deduplicate by normalised title
  const seen = new Set();
  const dedup = [];
  for (const item of all) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,50);
    if (!seen.has(key)) { seen.add(key); dedup.push(item); }
  }

  // newest first, keep top 24
  dedup.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const top = dedup.slice(0, 24);
  console.log(`   → ${top.length} unique articles scraped`);
  return top;
}

/* ═══════════════════════════════════════════════════════════
   STEP 2 — CLAUDE REWRITE (all 3 reading levels at once)
═══════════════════════════════════════════════════════════ */
async function rewriteForKids(rawArticles) {
  if (!rawArticles.length) return [];
  console.log(`✍️  Rewriting ${rawArticles.length} articles with Claude...`);

  // Send in batches of 12 to stay within token limits
  const BATCH = 12;
  const results = [];

  for (let i = 0; i < rawArticles.length; i += BATCH) {
    const batch = rawArticles.slice(i, i + BATCH);
    const startId = i + 1;

    const articleList = batch.map((a, j) =>
      `[${startId + j}] ${a.source}\nTitle: ${a.title}\nSnippet: ${a.summary || '(none)'}`
    ).join('\n\n');

    const prompt = `You are a cheerful, accurate science reporter for kids. Rewrite each article in THREE reading levels.

ARTICLES:
${articleList}

Return ONLY a valid JSON array — no markdown, no extra text.
Each object:
{
  "id": <number matching brackets above>,
  "headline": "Fun kid-friendly title, max 10 words",
  "category": "<robots|art|science|gaming|animals|space|cool>",
  "levels": {
    "young":  { "summary": "2 very simple sentences for a 7-year-old",      "wow": "One fun fact, max 10 words" },
    "middle": { "summary": "2-3 friendly sentences for a 10-year-old",      "wow": "One cool fact, max 14 words" },
    "older":  { "summary": "3 informative sentences for a 13-year-old",     "wow": "One insightful fact, max 18 words" }
  }
}
Rules: stay accurate, keep it positive and age-appropriate, no scary content.`;

    try {
      const msg = await anthropic.messages.create({
        model:      'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages:   [{ role: 'user', content: prompt }],
      });

      let text = (msg.content || []).map(b => b.text || '').join('');
      text = text.replace(/```json|```/g,'').trim();
      const s = text.indexOf('['), e = text.lastIndexOf(']');
      if (s === -1 || e === -1) throw new Error('No JSON array');

      const rewritten = JSON.parse(text.slice(s, e + 1));
      for (const rw of rewritten) {
        const raw = rawArticles[rw.id - 1];
        if (!raw) continue;
        results.push({
          id:       rw.id,
          headline: rw.headline,
          category: rw.category || detectCategory(raw.title, raw.summary),
          source:   raw.source,
          link:     raw.link,
          pubDate:  raw.pubDate,
          levels:   rw.levels,
        });
      }
    } catch (err) {
      console.warn(`  ⚠  Claude batch ${i}-${i+BATCH} failed: ${err.message}`);
      // fallback — include raw
      for (const a of batch) {
        results.push({
          id:       startId + batch.indexOf(a),
          headline: a.title,
          category: detectCategory(a.title, a.summary),
          source:   a.source,
          link:     a.link,
          pubDate:  a.pubDate,
          levels: {
            young:  { summary: a.summary.slice(0,150) || a.title, wow: 'AI is amazing!' },
            middle: { summary: a.summary.slice(0,250) || a.title, wow: 'This is a big deal for AI!' },
            older:  { summary: a.summary.slice(0,400) || a.title, wow: 'This could change how AI develops.' },
          },
        });
      }
    }
  }

  console.log(`   → ${results.length} articles rewritten`);
  return results;
}

/* ═══════════════════════════════════════════════════════════
   MAIN REFRESH PIPELINE
═══════════════════════════════════════════════════════════ */
async function refreshNews() {
  if (cache.isRefreshing) { console.log('⏭  Already refreshing, skipping.'); return; }
  cache.isRefreshing = true;
  console.log('\n🔄 Refresh started —', new Date().toLocaleTimeString());

  try {
    const raw      = await scrapeAllFeeds();
    const articles = await rewriteForKids(raw);
    cache.articles    = articles;
    cache.lastUpdated = new Date();
    console.log(`✅ Refresh complete — ${articles.length} articles ready\n`);
  } catch (err) {
    console.error('❌ Refresh pipeline error:', err.message);
  } finally {
    cache.isRefreshing = false;
  }
}

/* ═══════════════════════════════════════════════════════════
   EXPRESS APP
═══════════════════════════════════════════════════════════ */
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());

// Rate limiter on API routes
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX || '120'),
  message: { error: 'Too many requests — slow down a bit!' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Static frontend
app.use(express.static(path.join(__dirname, 'public')));

/* ── GET /api/news ─────────────────────────────────────── */
app.get('/api/news', (req, res) => {
  const level    = ['young','middle','older'].includes(req.query.level) ? req.query.level : 'middle';
  const category = req.query.category || 'all';
  const limit    = Math.min(parseInt(req.query.limit || '12'), 30);

  let articles = cache.articles;
  if (category !== 'all') articles = articles.filter(a => a.category === category);
  articles = articles.slice(0, limit);

  const shaped = articles.map(a => ({
    id:       a.id,
    headline: a.headline,
    category: a.category,
    source:   a.source,
    link:     a.link,
    pubDate:  a.pubDate,
    summary:  a.levels?.[level]?.summary || '',
    wow:      a.levels?.[level]?.wow     || '',
  }));

  res.json({
    ok:          true,
    count:       shaped.length,
    total:       cache.articles.length,
    lastUpdated: cache.lastUpdated,
    isRefreshing: cache.isRefreshing,
    articles:    shaped,
  });
});

/* ── GET /api/status ───────────────────────────────────── */
app.get('/api/status', (req, res) => {
  res.json({
    ok:           true,
    version:      '1.0.0',
    articleCount: cache.articles.length,
    lastUpdated:  cache.lastUpdated,
    isRefreshing: cache.isRefreshing,
    feeds:        RSS_FEEDS.map(f => f.source),
    refreshCron:  REFRESH_CRON,
    env:          NODE_ENV,
  });
});

/* ── POST /api/admin/refresh ───────────────────────────── */
app.post('/api/admin/refresh', (req, res) => {
  const token = req.headers['x-admin-secret'] || req.body?.secret;
  if (token !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  res.json({ ok: true, message: 'Refresh triggered.' });
  refreshNews();
});

/* ── catch-all → index.html ────────────────────────────── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ═══════════════════════════════════════════════════════════
   STARTUP
═══════════════════════════════════════════════════════════ */
app.listen(PORT, async () => {
  console.log(`\n🚀 Kids AI Buzz running → http://localhost:${PORT}`);
  console.log(`📺 ${RSS_FEEDS.length} RSS feeds configured`);
  console.log(`🔄 Auto-refresh: ${REFRESH_CRON}\n`);
  await refreshNews();
  cron.schedule(REFRESH_CRON, () => { console.log('[cron] Scheduled refresh'); refreshNews(); });
});
