require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const cron        = require('node-cron');
const RSSParser   = require('rss-parser');
const Anthropic   = require('@anthropic-ai/sdk');
const Stripe      = require('stripe');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const path        = require('path');
const db          = require('./db');

/* ═══════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════ */
const PORT          = process.env.PORT          || 3000;
const ADMIN_SECRET  = process.env.ADMIN_SECRET  || 'changeme';
const REFRESH_CRON  = process.env.REFRESH_CRON  || '0 */2 * * *';
const JWT_SECRET    = process.env.JWT_SECRET    || 'change-this-jwt-secret';
const APP_URL       = process.env.APP_URL       || `http://localhost:${PORT}`;
const PRICE_ID      = process.env.STRIPE_PRICE_ID;

if (!process.env.ANTHROPIC_API_KEY) { console.error('❌ ANTHROPIC_API_KEY missing'); process.exit(1); }
if (!process.env.STRIPE_SECRET_KEY) { console.error('❌ STRIPE_SECRET_KEY missing'); process.exit(1); }

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const stripe    = Stripe(process.env.STRIPE_SECRET_KEY);
const parser    = new RSSParser({ timeout: 8000, headers: { 'User-Agent': 'KidsAIBuzz/1.0' } });

const { extract } = require('@extractus/article-extractor');
const https = require('https');

/* ═══════════════════════════════════════════════
   SOURCES  — HN Algolia + RSS fallbacks
═══════════════════════════════════════════════ */
const RSS_FEEDS = [
  { url: 'https://venturebeat.com/category/ai/feed/',                          source: 'VentureBeat'   },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',  source: 'The Verge'     },
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/',      source: 'TechCrunch'    },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',           source: 'Ars Technica'  },
  { url: 'https://www.wired.com/feed/tag/ai/latest/rss',                       source: 'Wired'         },
  { url: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss',  source: 'IEEE Spectrum' },
  { url: 'https://www.artificialintelligence-news.com/feed/',                  source: 'AI News'       },
  { url: 'https://syncedreview.com/feed/',                                     source: 'Synced Review' },
];

const CATEGORY_KEYWORDS = {
  robots:  ['robot','robotic','drone','autonomous','humanoid','mechanical'],
  art:     ['dall-e','midjourney','stable diffusion','image generation','creative ai','suno','runway','sora','generative art'],
  gaming:  ['game','gaming','video game','minecraft','esport','npc','unity','unreal'],
  animals: ['animal','wildlife','species','ecology','biology','nature','ocean','bird','whale','conservation'],
  space:   ['space','nasa','astronaut','planet','satellite','telescope','mars','rocket','astronomy'],
  science: ['research','study','discovery','medical','health','brain','climate','quantum','cancer','diagnosis'],
  cool:    ['chatgpt','gpt-4','gemini','claude','llm','language model','openai','deepmind','anthropic','nvidia'],
};
function detectCategory(title, summary) {
  const text = (title + ' ' + summary).toLowerCase();
  for (const [cat, kws] of Object.entries(CATEGORY_KEYWORDS))
    if (kws.some(kw => text.includes(kw))) return cat;
  return 'cool';
}

/* ═══════════════════════════════════════════════
   NEWS CACHE
═══════════════════════════════════════════════ */
const cache = { articles: [], lastUpdated: null, isRefreshing: false };

/* ── fetch full article body from a URL ── */
async function fetchArticleBody(url) {
  try {
    const result = await Promise.race([
      extract(url, {}, { headers: { 'User-Agent': 'KidsAIBuzz/1.0 (+https://ai-news-buzz.onrender.com)' } }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
    ]);
    if (!result?.content) return '';
    // strip HTML tags, collapse whitespace
    return result.content.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim().slice(0, 3000);
  } catch { return ''; }
}

/* ── fetch top AI stories from HN Algolia ── */
async function fetchHNStories() {
  try {
    const queries = ['artificial intelligence','machine learning','openai','robotics','LLM','GPT','deepmind','anthropic'];
    const q = queries[Math.floor(Math.random() * queries.length)];
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=20&numericFilters=points>50`;
    const res = await new Promise((resolve, reject) => {
      https.get(url, { headers:{'User-Agent':'KidsAIBuzz/1.0'} }, (r) => {
        let data=''; r.on('data',c=>data+=c); r.on('end',()=>resolve(JSON.parse(data))); r.on('error',reject);
      }).on('error',reject);
    });
    return (res.hits||[])
      .filter(h => h.url && h.title && h.title.length > 15)
      .map(h => ({ title: h.title, link: h.url, pubDate: h.created_at, source: 'HN', hnPoints: h.points }));
  } catch(e) { console.warn('⚠ HN fetch failed:', e.message); return []; }
}

/* ── scrape RSS feeds ── */
async function scrapeFeed(feed) {
  try {
    const r = await parser.parseURL(feed.url);
    return (r.items || []).slice(0,8).map(i => ({
      title:   (i.title || '').replace(/&amp;/g,'&').replace(/&#8217;/g,"'").trim(),
      link:    i.link || '',
      pubDate: i.pubDate || i.isoDate || new Date().toISOString(),
      source:  feed.source,
    }));
  } catch(e) { console.warn(`⚠ ${feed.source}: ${e.message}`); return []; }
}

/* ── main scrape: HN + RSS, then fetch full bodies ── */
async function scrapeAllFeeds() {
  console.log('📡 Fetching stories...');
  const [hnStories, ...rssResults] = await Promise.allSettled([
    fetchHNStories(),
    ...RSS_FEEDS.map(scrapeFeed)
  ]);

  const hn  = hnStories.status === 'fulfilled' ? hnStories.value : [];
  const rss = rssResults.filter(r=>r.status==='fulfilled').flatMap(r=>r.value);
  const all = [...hn, ...rss].filter(a=>a.title?.length>15);

  // deduplicate
  const seen=new Set(), dedup=[];
  for(const item of all){
    const key=item.title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,50);
    if(!seen.has(key)){ seen.add(key); dedup.push(item); }
  }
  dedup.sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
  const top = dedup.slice(0,20);

  console.log(`   → ${top.length} stories, fetching full article bodies...`);

  // fetch full body for each article in parallel (with concurrency limit)
  const CONCURRENCY = 5;
  const withBodies = [];
  for(let i=0;i<top.length;i+=CONCURRENCY){
    const chunk = top.slice(i,i+CONCURRENCY);
    const bodies = await Promise.all(chunk.map(a => a.link ? fetchArticleBody(a.link) : Promise.resolve('')));
    chunk.forEach((a,j) => withBodies.push({ ...a, body: bodies[j] || '' }));
  }

  const goodArticles = withBodies.filter(a => a.body.length > 200 || a.title.length > 20);
  console.log(`   → ${goodArticles.length} articles with full content`);
  return goodArticles.slice(0,16);
}

async function rewriteForKids(rawArticles) {
  if(!rawArticles.length) return [];
  console.log(`✍️  Rewriting ${rawArticles.length} articles...`);
  const BATCH=12; const results=[];
  for(let i=0;i<rawArticles.length;i+=BATCH){
    const batch=rawArticles.slice(i,i+BATCH);
    const startId=i+1;
    const articleList=batch.map((a,j)=>`[${startId+j}] Title: ${a.title}\n${a.body ? 'Full article:\n'+a.body.slice(0,2000) : 'Snippet: (no content)'}`).join('\n\n---\n\n');
    const prompt=`You are a fun kids science writer for a magazine. Using the full article content below as your source material, write completely original articles in your own voice. Do NOT credit any source or publication.

STORIES:
${articleList}

Return ONLY a valid JSON array, no markdown.
Each object: { "id": <number>, "headline": "catchy original title max 10 words", "category": "<robots|art|science|gaming|animals|space|cool>", "levels": {
  "young":  { "summary": "2 simple sentences for age 7", "full": "3 short paragraphs (2-3 sentences each) telling the whole story for age 7. Use \\n\\n to separate paragraphs.", "wow": "one specific surprising fact, max 10 words" },
  "middle": { "summary": "2-3 sentences for age 10", "full": "4 paragraphs (3-4 sentences each) for age 10 with interesting details. Use \\n\\n between paragraphs.", "wow": "one specific interesting fact, max 14 words" },
  "older":  { "summary": "3 sentences for age 13", "full": "5 paragraphs (3-5 sentences each) for age 13 with context, details, and implications. Use \\n\\n between paragraphs.", "wow": "one specific insightful fact, max 18 words" }
} }

CRITICAL:
- "full" must have MULTIPLE PARAGRAPHS separated by \\n\\n
- Every wow must be SPECIFIC to that story — a real number, name, or detail
- NEVER use "big deal for AI", "AI is amazing", "this could change AI"
- Base everything on the actual article content provided
- Stay accurate, positive, age-appropriate`;
    try {
      const msg=await anthropic.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:6000, messages:[{role:'user',content:prompt}] });
      let text=(msg.content||[]).map(b=>b.text||'').join('').replace(/```json|```/g,'').trim();
      const s=text.indexOf('['),e=text.lastIndexOf(']');
      if(s===-1||e===-1) throw new Error('No JSON');
      const rw=JSON.parse(text.slice(s,e+1));
      for(const r of rw){
        const raw=rawArticles[r.id-1]; if(!raw) continue;
        results.push({ id:r.id, headline:r.headline, category:r.category||detectCategory(raw.title,raw.summary), source:raw.source, link:raw.link, pubDate:raw.pubDate, levels:r.levels });
      }
    } catch(err) {
      console.warn(`⚠ Batch failed: ${err.message}`);
      for(const a of batch) results.push({ id:startId+batch.indexOf(a), headline:a.title, category:detectCategory(a.title,a.summary), source:a.source, link:a.link, pubDate:a.pubDate,
        levels:{ young:{summary:a.summary.slice(0,150)||a.title, full:a.summary||a.title, wow:'Scientists worked really hard to build this.'}, middle:{summary:a.summary.slice(0,250)||a.title, full:a.summary||a.title, wow:'Researchers spent months testing before releasing it.'}, older:{summary:a.summary.slice(0,400)||a.title, full:a.summary||a.title, wow:'The team ran thousands of experiments to get here.'} } });
    }
  }
  console.log(`   → ${results.length} articles ready`);
  return results;
}

async function refreshNews() {
  if(cache.isRefreshing){console.log('⏭ Already refreshing');return;}
  cache.isRefreshing=true;
  console.log('\n🔄 Refresh started —',new Date().toLocaleTimeString());
  try{
    const raw=await scrapeAllFeeds();
    cache.articles=await rewriteForKids(raw);
    cache.lastUpdated=new Date();
    console.log(`✅ ${cache.articles.length} articles cached\n`);
  }catch(e){console.error('❌ Refresh error:',e.message);}
  finally{cache.isRefreshing=false;}
}

/* ═══════════════════════════════════════════════
   AUTH HELPERS
═══════════════════════════════════════════════ */
function signToken(userId) {
  return jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: '30d' });
}
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token' }); }
}
function isSubscribed(userId) {
  const user = db.get('users').find({ id: userId }).value();
  if (!user) return false;
  return user.subscriptionStatus === 'active';
}

/* ═══════════════════════════════════════════════
   EXPRESS APP
═══════════════════════════════════════════════ */
const app = express();

// raw body for Stripe webhooks BEFORE json middleware
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use('/api/', rateLimit({ windowMs:15*60*1000, max:120, standardHeaders:true, legacyHeaders:false }));
app.use(express.static(path.join(__dirname,'public')));

/* ─── AUTH ROUTES ─────────────────────────────── */

// POST /api/auth/signup
app.post('/api/auth/signup', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const existing = db.get('users').find({ email: email.toLowerCase() }).value();
  if (existing) return res.status(400).json({ error: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const id   = Date.now().toString();
  db.get('users').push({
    id, email: email.toLowerCase(), passwordHash: hash,
    stripeCustomerId: null, subscriptionStatus: 'free',
    subscriptionId: null, createdAt: new Date().toISOString()
  }).write();

  res.json({ token: signToken(id), email: email.toLowerCase(), subscribed: false });
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.get('users').find({ email: email?.toLowerCase() }).value();
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  res.json({ token: signToken(user.id), email: user.email, subscribed: user.subscriptionStatus === 'active' });
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ email: user.email, subscribed: user.subscriptionStatus === 'active', status: user.subscriptionStatus });
});

/* ─── STRIPE ROUTES ───────────────────────────── */

// POST /api/stripe/checkout  — create checkout session
app.post('/api/stripe/checkout', authMiddleware, async (req, res) => {
  const PROMO_COUPON_ID = process.env.STRIPE_PROMO_COUPON_ID;
  const promoRequested = req.body?.usePromo === true;
  const isPromo = promoRequested && !!PROMO_COUPON_ID && new Date() < new Date('2026-06-01T00:00:00Z');
  if (!PRICE_ID) return res.status(500).json({ error: 'Stripe price ID not configured' });
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.subscriptionStatus === 'active') return res.status(400).json({ error: 'Already subscribed' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.stripeCustomerId ? undefined : user.email,
      customer: user.stripeCustomerId || undefined,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      discounts: isPromo ? [{ coupon: PROMO_COUPON_ID }] : [],
      success_url: `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/?canceled=1`,
      metadata:    { userId: user.id },
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stripe/portal  — manage/cancel subscription
app.post('/api/stripe/portal', authMiddleware, async (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user?.stripeCustomerId) return res.status(400).json({ error: 'No subscription found' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer:   user.stripeCustomerId,
      return_url: APP_URL,
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stripe/webhook  — Stripe events
app.post('/api/stripe/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { console.error('Webhook error:', e.message); return res.status(400).send(`Webhook Error: ${e.message}`); }

  const session      = event.data.object;
  const customerId   = session.customer;
  const userId       = session.metadata?.userId || session.client_reference_id;
  const subStatus    = session.status;

  switch(event.type) {
    case 'checkout.session.completed': {
      const uid = session.metadata?.userId;
      if(uid) db.get('users').find({id:uid}).assign({ stripeCustomerId: customerId, subscriptionStatus:'active', subscriptionId: session.subscription }).write();
      break;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const status = event.data.object.status; // active, canceled, past_due, etc.
      const sub    = event.data.object;
      const user   = db.get('users').find({ stripeCustomerId: sub.customer }).value();
      if(user) db.get('users').find({id:user.id}).assign({ subscriptionStatus: status==='active'?'active':'canceled', subscriptionId: sub.id }).write();
      break;
    }
    case 'invoice.payment_failed': {
      const user = db.get('users').find({ stripeCustomerId: customerId }).value();
      if(user) db.get('users').find({id:user.id}).assign({ subscriptionStatus:'past_due' }).write();
      break;
    }
  }
  res.json({ received: true });
});

/* ─── NEWS API ────────────────────────────────── */
app.get('/api/news', (req, res) => {
  const level    = ['young','middle','older'].includes(req.query.level) ? req.query.level : 'middle';
  const category = req.query.category || 'all';
  const preview  = req.query.preview === 'true';

  // auth check
  let subscribed = false;
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(token) {
    try { const decoded=jwt.verify(token,JWT_SECRET); subscribed=isSubscribed(decoded.id); } catch{}
  }

  let articles = cache.articles;
  if(category!=='all') articles=articles.filter(a=>a.category===category);

  // free users get first 3 as preview
  const limit      = subscribed ? 30 : 3;
  const sliced     = articles.slice(0, limit);
  const hasMore    = !subscribed && cache.articles.length > 3;

  const shaped = sliced.map(a => ({
    id:       a.id,
    headline: a.headline,
    category: a.category,
    pubDate:  a.pubDate,
    summary:  a.levels?.[level]?.summary || '',
    full:     a.levels?.[level]?.full    || '',
    wow:      a.levels?.[level]?.wow     || '',
  }));

  res.json({ ok:true, count:shaped.length, total:cache.articles.length, lastUpdated:cache.lastUpdated, isRefreshing:cache.isRefreshing, subscribed, hasMore, articles:shaped });
});

/* ─── STATUS / ADMIN ──────────────────────────── */
app.get('/api/promo', (req, res) => {
  const isPromo = !!process.env.STRIPE_PROMO_COUPON_ID && new Date() < new Date('2026-06-01T00:00:00Z');
  res.json({ isPromo, promoPrice: '1.99', regularPrice: '3.99', promoEnds: '2026-06-01' });
});

app.get('/api/status', (req,res) => res.json({ ok:true, articleCount:cache.articles.length, lastUpdated:cache.lastUpdated, isRefreshing:cache.isRefreshing, users:db.get('users').size().value() }));

app.post('/api/admin/refresh', (req,res) => {
  if((req.headers['x-admin-secret']||req.body?.secret)!==ADMIN_SECRET) return res.status(403).json({error:'Forbidden'});
  res.json({ok:true,message:'Refresh started.'}); refreshNews();
});

app.get('*', (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));

/* ═══════════════════════════════════════════════
   STARTUP
═══════════════════════════════════════════════ */
app.listen(PORT, async () => {
  console.log(`\n🚀 Kids AI Buzz → http://localhost:${PORT}`);
  console.log(`💳 Stripe enabled: ${!!process.env.STRIPE_SECRET_KEY}`);
  console.log(`📡 ${RSS_FEEDS.length} RSS feeds | 🔄 Cron: ${REFRESH_CRON}\n`);
  await refreshNews();
  cron.schedule(REFRESH_CRON, () => { console.log('[cron] Refresh'); refreshNews(); });
});
