require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const cron        = require('node-cron');
const RSSParser   = require('rss-parser');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const Stripe      = require('stripe');
const bcrypt      = require('bcryptjs');
const jwt         = require('jsonwebtoken');
const path        = require('path');
const fs          = require('fs');
const db          = require('./db');

const CACHE_FILE  = path.join(__dirname, 'articles-cache.json');

/* ═══════════════════════════════════════════════
   CONFIG
═══════════════════════════════════════════════ */
const PORT          = process.env.PORT          || 3000;
const ADMIN_SECRET  = process.env.ADMIN_SECRET  || 'changeme';
const REFRESH_CRON  = process.env.REFRESH_CRON  || '*/30 * * * *';
const JWT_SECRET    = process.env.JWT_SECRET    || 'change-this-jwt-secret';
const APP_URL       = process.env.APP_URL       || `http://localhost:${PORT}`;
const PRICE_ID      = process.env.STRIPE_PRICE_ID;

if (!process.env.GEMINI_API_KEY)    { console.warn('⚠ GEMINI_API_KEY not set — rewriting disabled'); }
if (!process.env.STRIPE_SECRET_KEY) { console.warn('⚠ STRIPE_SECRET_KEY not set — payments disabled'); }

const genAI  = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const gemini = genAI ? genAI.getGenerativeModel({ model: 'gemini-1.5-flash' }) : null;
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
const parser = new RSSParser({ timeout: 8000, headers: { 'User-Agent': 'KidsAIBuzz/1.0' } });
const axios  = require('axios');

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
  // gaming
  { url: 'https://www.gamespot.com/feeds/mashup/',                             source: 'GameSpot'      },
  { url: 'https://kotaku.com/rss',                                              source: 'Kotaku'        },
  // space
  { url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',                     source: 'NASA'          },
  { url: 'https://feeds.feedburner.com/spacecom',                              source: 'Space.com'     },
  // animals / nature
  { url: 'https://www.nationalgeographic.com/rss',                             source: 'Nat Geo'       },
  // art / creative
  { url: 'https://www.creativebloq.com/feeds/all',                             source: 'Creative Bloq' },
];

const CATEGORY_KEYWORDS = {
  robots:  ['robot','robotic','drone','autonomous','humanoid','mechanical','boston dynamics','warehouse','delivery bot','self-driving','driverless','autopilot'],
  art:     ['dall-e','midjourney','stable diffusion','image generation','generative art','creative ai','suno','runway','sora','ai music','ai video','ai image','ai art','text-to-image','text to image'],
  gaming:  ['game','gaming','video game','minecraft','fortnite','esport','npc','unity','unreal','playstation','xbox','nintendo','steam','gamer','gameplay','game dev','game ai'],
  animals: ['animal','wildlife','species','ecology','biology','nature','ocean','bird','whale','conservation','endangered','pet','dog','cat','fish','monkey','elephant','zoo','habitat'],
  space:   ['space','nasa','astronaut','planet','satellite','telescope','mars','rocket','astronomy','cosmos','exoplanet','james webb','moon','orbit','galaxy','star','solar system','spacex'],
  science: ['research','study','discovery','medical','health','brain','climate','quantum','physics','chemistry','cancer','diagnosis','medicine','hospital','scientist','laboratory','experiment','gene','dna'],
  cool:    ['chatgpt','gpt','gemini','llm','language model','openai','deepmind','anthropic','nvidia','chip','processor','neural network','machine learning','breakthrough','record','first ever','new model','ai assistant','copilot'],
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

// load from disk on startup so articles survive restarts
try {
  if (fs.existsSync(CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    cache.articles    = saved.articles    || [];
    cache.lastUpdated = saved.lastUpdated ? new Date(saved.lastUpdated) : null;
    console.log(`📦 Loaded ${cache.articles.length} cached articles from disk`);
  }
} catch(e) { console.warn('⚠ Could not load cache from disk:', e.message); }

/* ── fetch full article body from a URL ── */
async function fetchArticleBody(url) {
  try {
    const res = await axios.get(url, {
      timeout: 4000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; KidsAIBuzz/1.0)' },
      maxContentLength: 200000,
    });
    const html = res.data || '';
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);
  } catch { return ''; }
}

/* ── fetch HN stories ── */
async function fetchHNStories() {
  try {
    const queries = [
      'artificial intelligence', 'machine learning', 'openai GPT',
      'robotics automation', 'AI gaming video games',
      'AI animals wildlife nature', 'space NASA rocket',
      'AI art image generation', 'AI medical health',
      'deepmind anthropic nvidia', 'AI science discovery'
    ];
    // fetch multiple queries in parallel
    const results = await Promise.all(
      queries.slice(0,7).map(q =>
        axios.get(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=15&numericFilters=points>20`, { timeout: 5000 })
          .then(r => (r.data.hits||[]).filter(h=>h.url&&h.title?.length>15).map(h=>({ title:h.title, link:h.url, pubDate:h.created_at, source:'HN', snippet:'' })))
          .catch(()=>[])
      )
    );
    return results.flat();
  } catch(e) { console.warn('⚠ HN failed:', e.message); return []; }
}

/* ── scrape RSS feed ── */
async function scrapeFeed(feed) {
  try {
    const r = await parser.parseURL(feed.url);
    return (r.items || []).slice(0, 10).map(i => ({
      title:   (i.title || '').replace(/&amp;/g,'&').replace(/&#8217;/g,"'").trim(),
      link:    i.link || '',
      pubDate: i.pubDate || i.isoDate || new Date().toISOString(),
      source:  feed.source,
      snippet: (i.contentSnippet || i.description || '').replace(/<[^>]+>/g,'').slice(0, 800).trim(),
    }));
  } catch(e) { console.warn(`⚠ ${feed.source}: ${e.message}`); return []; }
}

/* ── main pipeline ── */
async function scrapeAllFeeds() {
  console.log('📡 Fetching stories...');

  const [hnResult, ...rssResults] = await Promise.allSettled([
    fetchHNStories(),
    ...RSS_FEEDS.map(scrapeFeed)
  ]);

  const hn  = hnResult.status === 'fulfilled' ? hnResult.value : [];
  const rss = rssResults.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
  const all = [...hn, ...rss].filter(a => a.title?.length > 15);

  // deduplicate
  const seen = new Set(), dedup = [];
  for (const item of all) {
    const key = item.title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,50);
    if (!seen.has(key)) { seen.add(key); dedup.push(item); }
  }
  dedup.sort((a,b) => new Date(b.pubDate) - new Date(a.pubDate));
  const top = dedup.slice(0, 100); // grab top 100 to ensure 12 per category
  console.log(`   → ${top.length} stories found`);

  // fetch all bodies in parallel
  console.log('   → Fetching bodies in parallel...');
  const bodies = await Promise.all(
    top.map(a => a.link ? fetchArticleBody(a.link) : Promise.resolve(''))
  );

  const withContent = top.map((a, i) => ({
    ...a,
    body: bodies[i] || a.snippet || '',
  })).filter(a => (a.body?.length > 100) || a.title?.length > 20);

  console.log(`   → ${withContent.length} articles with content`);
  return withContent.slice(0, 84);
}

async function rewriteForKids(rawArticles) {
  if(!rawArticles.length) return [];
  // only rewrite first 24 fresh articles per refresh — pool grows over time
  const toRewrite = rawArticles.slice(0, 24);
  console.log(`✍️  Rewriting ${toRewrite.length} articles...`);
  const BATCH=3; const results=[];

  for(let i=0;i<toRewrite.length;i+=BATCH){
    const batch=toRewrite.slice(i,i+BATCH);
    const startId=i+1;
    const articleList=batch.map((a,j)=>`[${startId+j}] Title: ${a.title}\n${a.body ? 'Content:\n'+a.body.slice(0,1200) : 'No content'}`).join('\n\n---\n\n');
    const prompt=`You are a fun kids science writer. Write original kid-friendly articles based on the stories below. Do NOT credit any source.

${articleList}

Return ONLY a valid JSON array (no markdown, no extra text).
Each object must have exactly:
{
  "id": <number>,
  "headline": "fun title max 10 words",
  "category": "robots|art|science|gaming|animals|space|cool",
  "levels": {
    "young":  { "summary": "2 simple sentences age 7", "full": "3 paragraphs age 7, separated by \\n\\n", "wow": "surprising fact max 10 words" },
    "middle": { "summary": "2-3 sentences age 10",    "full": "5 paragraphs age 10, separated by \\n\\n", "wow": "interesting fact max 14 words" },
    "older":  { "summary": "3 sentences age 13",      "full": "7 paragraphs age 13, separated by \\n\\n", "wow": "insightful fact max 18 words" }
  }
}
Rules: multiple paragraphs with \\n\\n, wow must be specific to THIS story, never generic AI phrases.`;

    for(let attempt=0; attempt<3; attempt++){
      try {
        if(!gemini) throw new Error('Gemini not configured');
        const result = await gemini.generateContent(prompt);
        let text = result.response.text().replace(/```json|```/g,'').trim();
        const s=text.indexOf('['),e=text.lastIndexOf(']');
        if(s===-1||e===-1) throw new Error('No JSON array');
        const rw=JSON.parse(text.slice(s,e+1));
        for(const r of rw){
          const raw=toRewrite[r.id-1]; if(!raw) continue;
          results.push({ id: Date.now()+r.id, headline:r.headline, category:r.category||detectCategory(raw.title,raw.body||''), source:raw.source, link:raw.link, pubDate:raw.pubDate, levels:r.levels });
        }
        console.log(`   ✓ Batch ${Math.floor(i/BATCH)+1} done (${rw.length} articles)`);
        break; // success
      } catch(err) {
        console.warn(`   ⚠ Batch ${Math.floor(i/BATCH)+1} attempt ${attempt+1} failed: ${err.message}`);
        if(attempt===2){
          // final fallback
          for(const a of batch){
            results.push({ id:Date.now()+Math.random(), headline:a.title, category:detectCategory(a.title,a.body||''), source:a.source, link:a.link, pubDate:a.pubDate,
              levels:{ young:{summary:a.title,full:a.body?.slice(0,400)||a.title,wow:'Scientists made a cool discovery!'}, middle:{summary:a.title,full:a.body?.slice(0,600)||a.title,wow:'Researchers worked hard on this project.'}, older:{summary:a.title,full:a.body?.slice(0,800)||a.title,wow:'This represents a significant technical achievement.'} }
            });
          }
        }
        await new Promise(r=>setTimeout(r,2000)); // wait 2s before retry
      }
    }
  }
  console.log(`   → ${results.length} articles rewritten`);
  return results;
}

async function refreshNews() {
  if(cache.isRefreshing){console.log('⏭ Already refreshing');return;}
  cache.isRefreshing=true;
  console.log('\n🔄 Refresh started —',new Date().toLocaleTimeString());
  try{
    const raw      = await scrapeAllFeeds();
    const rewritten = await rewriteForKids(raw);
    if(!rewritten || !rewritten.length){ console.warn('⚠ No articles rewritten'); cache.isRefreshing=false; return; }

    // ensure 9 per category — group and pad
    const CATS = ['robots','art','science','gaming','animals','space','cool'];
    const byCategory = {};
    CATS.forEach(c => byCategory[c] = []);
    for(const a of rewritten){
      const c = a.category || 'cool';
      if(!byCategory[c]) byCategory[c] = [];
      byCategory[c].push(a);
    }

    // if any category has fewer than 9, fill from 'cool' overflow or recycle
    let overflow = rewritten.filter(a => byCategory[a.category]?.length > 12);
    CATS.forEach(c => {
      while(byCategory[c].length < 12 && overflow.length){
        const extra = overflow.shift();
        byCategory[c].push({...extra, category: c});
      }
    });

    // flatten: 12 per category = 84 total
    const final = [];
    for(let i=0;i<12;i++){
      CATS.forEach(c => { if(byCategory[c][i]) final.push(byCategory[c][i]); });
    }

    // merge with existing cache — keep old articles, add new ones at top
    const existingIds = new Set((cache.articles||[]).map(a=>a.id||a.headline));
    const brandNew = final.filter(a => !existingIds.has(a.id||a.headline));
    const merged = [...brandNew, ...(cache.articles||[])].slice(0, 500); // keep up to 500 articles

    cache.articles    = merged;
    cache.lastUpdated = new Date();
    try {
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ articles: merged, lastUpdated: cache.lastUpdated }));
      console.log(`💾 Cache saved to disk`);
    } catch(e) { console.warn('⚠ Could not save cache:', e.message); }
    console.log(`✅ ${merged.length} total articles (${brandNew.length} new)\n`);
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

app.set('trust proxy', 1);
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
  if (!stripe) return res.status(500).json({ error: 'Payments not configured' });
  const PROMO_COUPON_ID = process.env.STRIPE_PROMO_COUPON_ID;
  const promoRequested = req.body?.usePromo === true;
  const isPromo = promoRequested && !!PROMO_COUPON_ID && new Date() < new Date('2026-06-01T00:00:00Z');
  if (!PRICE_ID) return res.status(500).json({ error: 'Stripe price ID not configured' });
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.subscriptionStatus === 'active') return res.status(400).json({ error: 'Already subscribed' });

  try {
    const sessionParams = {
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.stripeCustomerId ? undefined : user.email,
      customer: user.stripeCustomerId || undefined,
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      subscription_data: { trial_period_days: 7 },
      success_url: `${APP_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${APP_URL}/?canceled=1`,
      metadata:    { userId: user.id },
    };
    if (isPromo) sessionParams.discounts = [{ coupon: PROMO_COUPON_ID }];
    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/stripe/portal  — manage/cancel subscription
app.post('/api/stripe/portal', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Payments not configured' });
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
  if (!stripe) return res.status(500).json({ error: 'Payments not configured' });
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
  const page     = Math.max(1, parseInt(req.query.page || '1'));
  const pageSize = 12;

  // auth check
  let subscribed = false;
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(token) {
    try { const decoded=jwt.verify(token,JWT_SECRET); subscribed=isSubscribed(decoded.id); } catch{}
  }

  let articles = cache.articles;

  // build free set: 3 per category
  const CATS = ['robots','art','science','gaming','animals','space','cool'];
  let freeArticles = [];
  if(!subscribed){
    const byCat = {};
    CATS.forEach(c => byCat[c] = cache.articles.filter(a=>a.category===c).sort(()=>Math.random()-.5).slice(0,3));
    freeArticles = CATS.flatMap(c => byCat[c]);
  }

  // filter by category
  if(category !== 'all'){
    articles = articles.filter(a=>a.category===category);
    if(!subscribed) freeArticles = freeArticles.filter(a=>a.category===category);
  }

  const freeIds = new Set(freeArticles.map(a=>a.id));
  const lockedArticles = subscribed ? [] : articles.filter(a=>!freeIds.has(a.id));
  const allSorted = subscribed ? articles : freeArticles;

  // paginate
  const start     = (page - 1) * pageSize;
  const sliced    = allSorted.slice(start, start + pageSize);
  const hasMore   = subscribed
    ? start + pageSize < articles.length
    : false; // free users always see all their free articles on page 1

  const shaped = sliced.map(a => ({
    id:       a.id,
    headline: a.headline,
    category: a.category,
    pubDate:  a.pubDate,
    summary:  a.levels?.[level]?.summary || '',
    full:     a.levels?.[level]?.full || '',
    wow:      a.levels?.[level]?.wow || '',
    locked:   false,
  }));

  // locked previews only on first page
  const lockedShaped = page === 1 ? lockedArticles.map(a => ({
    id:       a.id,
    headline: a.headline,
    category: a.category,
    pubDate:  a.pubDate,
    summary:  (a.levels?.[level]?.summary || '').split('.')[0] + '...',
    full:     '',
    wow:      '',
    locked:   true,
  })) : [];

  res.json({ ok:true, count:shaped.length, total:cache.articles.length, page, hasMore, lastUpdated:cache.lastUpdated, isRefreshing:cache.isRefreshing, subscribed, articles:[...shaped, ...lockedShaped] });
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

  // only scrape on startup if cache is empty or older than 2 hours
  const cacheAge = cache.lastUpdated ? (Date.now() - new Date(cache.lastUpdated)) : Infinity;
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  if (cache.articles.length === 0 || cacheAge > TWO_HOURS) {
    console.log('🔄 Cache is stale or empty — refreshing...');
    await refreshNews();
  } else {
    console.log(`✅ Using cached articles (${cache.articles.length} articles, ${Math.round(cacheAge/60000)}m old)`);
  }

  cron.schedule(REFRESH_CRON, () => { console.log('[cron] Refresh'); refreshNews(); });
});