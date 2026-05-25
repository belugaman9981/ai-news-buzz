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

/* ═══════════════════════════════════════════════
   RSS FEEDS
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

async function scrapeFeed(feed) {
  try {
    const r = await parser.parseURL(feed.url);
    return (r.items || []).slice(0,10).map(i => ({
      title:   (i.title || '').replace(/&amp;/g,'&').replace(/&#8217;/g,"'").trim(),
      summary: (i.contentSnippet || i.description || '').replace(/<[^>]+>/g,'').slice(0,500).trim(),
      link:    i.link || '',
      pubDate: i.pubDate || i.isoDate || new Date().toISOString(),
      source:  feed.source,
    }));
  } catch(e) { console.warn(`⚠ ${feed.source}: ${e.message}`); return []; }
}

async function scrapeAllFeeds() {
  console.log('📡 Scraping feeds...');
  const settled = await Promise.allSettled(RSS_FEEDS.map(scrapeFeed));
  const all = settled.filter(r=>r.status==='fulfilled').flatMap(r=>r.value).filter(a=>a.title?.length>15);
  const seen=new Set(), dedup=[];
  for(const item of all){
    const key=item.title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,50);
    if(!seen.has(key)){ seen.add(key); dedup.push(item); }
  }
  dedup.sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
  console.log(`   → ${dedup.slice(0,24).length} articles`);
  return dedup.slice(0,24);
}

async function rewriteForKids(rawArticles) {
  if(!rawArticles.length) return [];
  console.log(`✍️  Rewriting ${rawArticles.length} articles...`);
  const BATCH=12; const results=[];
  for(let i=0;i<rawArticles.length;i+=BATCH){
    const batch=rawArticles.slice(i,i+BATCH);
    const startId=i+1;
    const articleList=batch.map((a,j)=>`[${startId+j}] Title: ${a.title}\nSnippet: ${a.summary||'(none)'}`).join('\n\n');
    const prompt=`You are a fun kids science writer. Using the news stories below as your source material, write completely original articles in your own voice — like a kids magazine writer who heard about the story and is telling it fresh. Do NOT credit any source or publication.

STORIES:
${articleList}

Return ONLY a valid JSON array, no markdown.
Each object: { "id": <number>, "headline": "catchy original title max 10 words", "category": "<robots|art|science|gaming|animals|space|cool>", "levels": { "young": { "summary": "2 simple sentences for age 7 written in your own words", "wow": "one specific surprising fact from THIS story, max 10 words" }, "middle": { "summary": "2-3 sentences for age 10 written in your own words", "wow": "one specific interesting fact from THIS story, max 14 words" }, "older": { "summary": "3 sentences for age 13 written in your own words", "wow": "one specific insightful fact from THIS story, max 18 words" } } }

CRITICAL rules for "wow":
- Every wow must be SPECIFIC to that individual story — a real number, a real thing that happened, or a surprising detail
- NEVER use generic phrases like "big deal for AI", "AI is amazing", "this could change AI", "AI is doing great things"
- Good examples: "The robot can fold 50 shirts per hour", "The model was trained on 10 trillion words", "It beat world champions at chess in under 3 seconds"
- Bad examples: "AI is amazing!", "This is a big deal!", "Technology is changing fast!"
Stay accurate, positive, age-appropriate.`;
    try {
      const msg=await anthropic.messages.create({ model:'claude-sonnet-4-20250514', max_tokens:3000, messages:[{role:'user',content:prompt}] });
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
        levels:{ young:{summary:a.summary.slice(0,150)||a.title,wow:'Scientists worked really hard to build this.'}, middle:{summary:a.summary.slice(0,250)||a.title,wow:'Researchers spent months testing before releasing it.'}, older:{summary:a.summary.slice(0,400)||a.title,wow:'The team ran thousands of experiments to get here.'} } });
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
  const PROMO_PRICE_ID = process.env.STRIPE_PROMO_PRICE_ID;
  const promoRequested = req.body?.usePromo === true;
  const isPromo = promoRequested && !!PROMO_PRICE_ID && new Date() < new Date('2026-06-01T00:00:00Z');
  const activePriceId = isPromo ? PROMO_PRICE_ID : PRICE_ID;
  if (!activePriceId) return res.status(500).json({ error: 'Stripe price ID not configured' });
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.subscriptionStatus === 'active') return res.status(400).json({ error: 'Already subscribed' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: user.stripeCustomerId ? undefined : user.email,
      customer: user.stripeCustomerId || undefined,
      line_items: [{ price: activePriceId, quantity: 1 }],
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
    wow:      a.levels?.[level]?.wow     || '',
  }));

  res.json({ ok:true, count:shaped.length, total:cache.articles.length, lastUpdated:cache.lastUpdated, isRefreshing:cache.isRefreshing, subscribed, hasMore, articles:shaped });
});

/* ─── STATUS / ADMIN ──────────────────────────── */
app.get('/api/promo', (req, res) => {
  const isPromo = !!process.env.STRIPE_PROMO_PRICE_ID && new Date() < new Date('2026-06-01T00:00:00Z');
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
