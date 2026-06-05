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
const nodemailer  = require('nodemailer');
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
const REFRESH_CRON  = process.env.REFRESH_CRON  || '0 6 * * *';
const JWT_SECRET    = process.env.JWT_SECRET    || 'change-this-jwt-secret';
const APP_URL       = process.env.APP_URL       || `http://localhost:${PORT}`;
const PRICE_ID      = process.env.STRIPE_PRICE_ID;

if (!process.env.GEMINI_API_KEY)    { console.warn('⚠ GEMINI_API_KEY not set — rewriting disabled'); }
if (!process.env.STRIPE_SECRET_KEY) { console.warn('⚠ STRIPE_SECRET_KEY not set — payments disabled'); }

const genAI  = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;
const gemini = genAI ? genAI.getGenerativeModel({ model: 'gemini-2.0-flash' }) : null;
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!process.env.GMAIL_APP_PASSWORD) { console.warn('⚠ GMAIL_APP_PASSWORD not set — emails disabled'); }
const mailer = process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: 'kidsaibuzz@gmail.com', pass: process.env.GMAIL_APP_PASSWORD }
    })
  : null;
const FROM   = 'kidsaibuzz@gmail.com';
const parser = new RSSParser({ timeout: 8000, headers: { 'User-Agent': 'KidsAIBuzz/1.0' } });
const axios  = require('axios');

/* ═══════════════════════════════════════════════
   SOURCES  — HN Algolia + RSS fallbacks
═══════════════════════════════════════════════ */
const RSS_FEEDS = [
  // General AI
  { url: 'https://venturebeat.com/category/ai/feed/',                          source: 'VentureBeat'   },
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',  source: 'The Verge'     },
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/',      source: 'TechCrunch'    },
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',           source: 'Ars Technica'  },
  { url: 'https://www.wired.com/feed/tag/ai/latest/rss',                       source: 'Wired'         },
  { url: 'https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss',  source: 'IEEE Spectrum' },
  { url: 'https://www.artificialintelligence-news.com/feed/',                  source: 'AI News'       },
  { url: 'https://syncedreview.com/feed/',                                     source: 'Synced Review' },
  // Robots specifically
  { url: 'https://spectrum.ieee.org/feeds/topic/robotics.rss',                 source: 'IEEE Robotics' },
  { url: 'https://techcrunch.com/category/robotics/feed/',                     source: 'TC Robotics'   },
  { url: 'https://www.therobotreport.com/feed/',                               source: 'Robot Report'  },
  // AI Art specifically
  { url: 'https://www.creativebloq.com/feeds/all',                             source: 'Creative Bloq' },
  { url: 'https://aiartists.org/feed',                                         source: 'AI Artists'    },
  { url: 'https://techcrunch.com/category/media-entertainment/feed/',          source: 'TC Media'      },
  // Science specifically
  { url: 'https://www.newscientist.com/feed/home/',                            source: 'New Scientist' },
  { url: 'https://feeds.feedburner.com/sciencedaily',                          source: 'Science Daily' },
  { url: 'https://phys.org/rss-feed/breaking/',                                source: 'Phys.org'      },
  // Gaming
  { url: 'https://www.gamespot.com/feeds/mashup/',                             source: 'GameSpot'      },
  { url: 'https://kotaku.com/rss',                                              source: 'Kotaku'        },
  // Space
  { url: 'https://www.nasa.gov/rss/dyn/breaking_news.rss',                     source: 'NASA'          },
  { url: 'https://feeds.feedburner.com/spacecom',                              source: 'Space.com'     },
  // Animals / Nature
  { url: 'https://www.nationalgeographic.com/rss',                             source: 'Nat Geo'       },
  { url: 'https://www.sciencenews.org/feed',                                   source: 'Science News'  },
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
      'artificial intelligence machine learning',
      'robotics robot automation humanoid',
      'AI art image generation Midjourney DALL-E Stable Diffusion',
      'AI science medical research discovery',
      'AI gaming video games NPC',
      'space NASA rocket astronomy telescope',
      'AI animals wildlife nature conservation',
      'openai GPT deepmind anthropic',
      'robot drone autonomous vehicle',
      'AI medical health diagnosis',
    ];
    // fetch all queries in parallel
    const results = await Promise.all(
      queries.map(q =>
        axios.get(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=10&numericFilters=points>20`, { timeout: 5000 })
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
    return (r.items || []).slice(0, 20).map(i => ({
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

  // deduplicate by URL (strip query params) and by title prefix
  const seenUrls = new Set(), seenTitles = new Set(), dedup = [];
  for (const item of all) {
    const urlKey = item.link ? (() => { try { const u = new URL(item.link); return u.hostname + u.pathname; } catch { return item.link; } })() : '';
    const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0, 60);
    if ((urlKey && seenUrls.has(urlKey)) || seenTitles.has(titleKey)) continue;
    if (urlKey) seenUrls.add(urlKey);
    seenTitles.add(titleKey);
    dedup.push(item);
  }
  // semantic dedup — drop articles that cover the same subject as an earlier one
  const STOP_WORDS = new Set(['a','an','the','is','are','was','were','has','have','had','be','been','being','in','on','at','to','for','of','and','or','but','with','by','from','as','it','its','this','that','how','why','what','when','where','who','will','can','could','would','should','may','might','new','says','say','said','use','uses','used','ai','after','before','over','more','than','about','into','all','up','out','one','two','three','first','just','not','their','they','its','our','your','his','her']);
  function titleKeywords(t) {
    return new Set(t.toLowerCase().replace(/[^a-z0-9 ]/g,'').split(/\s+/).filter(w => w.length > 3 && !STOP_WORDS.has(w)));
  }
  const semDedup = [], seenWordSets = [];
  for (const item of dedup) {
    const words = titleKeywords(item.title);
    if (words.size === 0) { semDedup.push(item); continue; }
    let tooSimilar = false;
    for (const seen of seenWordSets) {
      const overlap = [...words].filter(w => seen.has(w)).length / Math.min(words.size, seen.size);
      if (overlap >= 0.5) { tooSimilar = true; break; }
    }
    if (!tooSimilar) { semDedup.push(item); seenWordSets.push(words); }
  }

  semDedup.sort((a,b) => new Date(b.pubDate) - new Date(a.pubDate));
  const top = semDedup.slice(0, 200); // grab top 200 to ensure more per category
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
  return withContent.slice(0, 160);
}

async function rewriteForKids(rawArticles) {
  if(!rawArticles.length) return [];
  // only rewrite first 24 fresh articles per refresh to stay within free-tier daily quota
  const toRewrite = rawArticles.slice(0, 24);
  console.log(`✍️  Rewriting ${toRewrite.length} articles...`);
  const BATCH=3; const results=[];
  let dailyQuotaExhausted = false;

  for(let i=0;i<toRewrite.length;i+=BATCH){
    if(dailyQuotaExhausted) break;
    const batch=toRewrite.slice(i,i+BATCH);
    const startId=i+1;
    const articleList=batch.map((a,j)=>`[${startId+j}] Title: ${a.title}\n${a.body ? 'Content:\n'+a.body.slice(0,1200) : 'No content'}`).join('\n\n---\n\n');
    const prompt=`You are a fun kids science writer for a magazine. Write completely original kid-friendly articles based on the stories below. Do NOT credit any source.

${articleList}

Return ONLY a valid JSON array (no markdown, no extra text).
Each object must have exactly:
{
  "id": <number>,
  "headline": "fun title max 10 words",
  "category": "robots|art|science|gaming|animals|space|cool",
  "levels": {
    "young":  { "summary": "2 simple sentences age 7", "full": "5 paragraphs for age 7, each 3-4 sentences. Use very simple fun words. Separate every paragraph with \\n\\n", "wow": "surprising fact max 10 words" },
    "middle": { "summary": "2-3 sentences age 10",    "full": "7 paragraphs for age 10, each 4-5 sentences. Include what happened, why it matters, how it works, who did it, cool details, and what comes next. Separate every paragraph with \\n\\n", "wow": "interesting fact max 14 words" },
    "older":  { "summary": "3 sentences age 13",      "full": "9 paragraphs for age 13, each 4-6 sentences. Include background, what happened, technical details, expert reactions, real world impact, comparisons, and future implications. Separate every paragraph with \\n\\n", "wow": "insightful fact max 18 words" }
  }
}
CRITICAL rules:
- paragraphs MUST be separated by \\n\\n
- wow must be specific to THIS story — a real number, name, or detail. NEVER say "big deal for AI" or "AI is amazing"
- For category, be creative and varied — use ALL categories across the batch:
  robots = self-driving, drones, automation, humanoids, robotic arms
  art = image/video/music generation, creative tools, AI design
  science = medicine, climate, biology, physics, research, health
  gaming = video games, esports, game AI, game engines
  animals = wildlife, ecology, pets, nature, conservation
  space = NASA, rockets, planets, telescopes, astronomy
  cool = everything else (chatbots, LLMs, chips, breakthroughs)
- SPREAD categories — if 3 articles, try to use 3 different categories`;

    for(let attempt=0; attempt<3; attempt++){
      try {
        if(!gemini) throw new Error('Gemini not configured');
        const result = await gemini.generateContent(prompt);
        let text = result.response.text();
        // strip markdown fences without using backticks in regex
        text = text.split('\n').filter(l => !l.startsWith('```')).join('\n').trim();
        const s=text.indexOf('['),e=text.lastIndexOf(']');
        if(s===-1||e===-1) throw new Error('No JSON array');
        const rw=JSON.parse(text.slice(s,e+1));
        for(const r of rw){
          const raw=toRewrite[r.id-1]; if(!raw) continue;
          results.push({ id: Date.now()+r.id, headline:r.headline, category:r.category||detectCategory(raw.title,raw.body||''), source:raw.source, link:raw.link, pubDate:raw.pubDate, levels:r.levels });
        }
        console.log(`   ✓ Batch ${Math.floor(i/BATCH)+1} done (${rw.length} articles)`);
        // small delay between successful batches to stay within per-minute quota
        if(i+BATCH < toRewrite.length) await new Promise(r=>setTimeout(r,5000));
        break; // success
      } catch(err) {
        const msg = err.message || '';
        const batchNum = Math.floor(i/BATCH)+1;
        console.warn(`   ⚠ Batch ${batchNum} attempt ${attempt+1} failed: ${msg.slice(0,120)}`);

        // if daily quota is exhausted, stop all further batches immediately
        if(msg.includes('PerDay') || (msg.includes('limit: 0') && msg.includes('Per'))){
          console.warn('   ✖ Daily Gemini quota exhausted — skipping remaining batches');
          dailyQuotaExhausted = true;
          break;
        }

        if(attempt===2){
          // final fallback — use raw content
          for(const a of batch){
            results.push({ id:Date.now()+Math.random(), headline:a.title, category:detectCategory(a.title,a.body||''), source:a.source, link:a.link, pubDate:a.pubDate,
              levels:{ young:{summary:a.title,full:a.body?.slice(0,400)||a.title,wow:'Scientists made a cool discovery!'}, middle:{summary:a.title,full:a.body?.slice(0,600)||a.title,wow:'Researchers worked hard on this project.'}, older:{summary:a.title,full:a.body?.slice(0,800)||a.title,wow:'This represents a significant technical achievement.'} }
            });
          }
        } else {
          // extract retry delay from 429 response (Google sends it in the error message)
          const delayMatch = msg.match(/retry in (\d+(?:\.\d+)?)s/i);
          const waitMs = delayMatch ? Math.min(Math.ceil(parseFloat(delayMatch[1])) * 1000, 60000) : 5000;
          console.warn(`   ⏳ Waiting ${waitMs/1000}s before retry...`);
          await new Promise(r=>setTimeout(r,waitMs));
        }
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
    // distribute overflow to emptiest categories first
    const sortedBySize = [...CATS].sort((a,b) => byCategory[a].length - byCategory[b].length);
    let overflow = rewritten.filter(a => byCategory[a.category]?.length > 12);
    for(const c of sortedBySize){
      while(byCategory[c].length < 12 && overflow.length){
        const extra = overflow.shift();
        byCategory[c].push({...extra, category: c});
      }
    }

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
   EMAIL HELPERS
═══════════════════════════════════════════════ */
async function sendWelcomeEmail(email) {
  if (!mailer) { console.warn('⚠ sendWelcomeEmail: Gmail not configured, skipping.'); return; }
  try {
    await mailer.sendMail({
      from: '"Kids AI Buzz" <kidsaibuzz@gmail.com>',
      to: email,
      subject: '🚀 Welcome to Kids AI Buzz!',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
          <h1 style="color:#7C6FF7;font-size:28px">Welcome to Kids AI Buzz! ✨</h1>
          <p style="font-size:16px;color:#444;line-height:1.6">
            Hey there! Thanks for signing up. Every week we'll send you the <strong>top 5 AI stories</strong> 
            explained in a fun way that kids actually understand.
          </p>
          <p style="font-size:16px;color:#444;line-height:1.6">
            AI is changing the world — and we think every kid should know about it! 🤖🎨🚀
          </p>
          <a href="https://ai-news-buzz.onrender.com" 
             style="display:inline-block;background:#7C6FF7;color:#fff;padding:12px 28px;border-radius:99px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:1rem">
            Read today's stories →
          </a>
          <p style="font-size:13px;color:#999;margin-top:2rem">
            You're receiving this because you signed up at Kids AI Buzz. 
            <a href="https://ai-news-buzz.onrender.com/unsubscribe?email=${encodeURIComponent(email)}" style="color:#999">Unsubscribe</a>
          </p>
        </div>`
    });
    console.log(`📧 Welcome email sent to ${email}`);
  } catch(e) { console.warn('⚠ Welcome email failed:', e.message); }
}

async function sendSignupWelcomeEmail(email) {
  if (!mailer) { console.warn('⚠ sendSignupWelcomeEmail: Gmail not configured, skipping.'); return; }
  try {
    await mailer.sendMail({
      from: `"Kids AI Buzz" <${FROM}>`,
      to: email,
      subject: '👋 Welcome to Kids AI Buzz!',
      html: `
        <div style="font-family:sans-serif;max-width:580px;margin:0 auto;padding:2rem;background:#fff">

          <div style="text-align:center;margin-bottom:2rem">
            <h1 style="color:#7C6FF7;font-size:32px;margin:0">Kids AI Buzz 🤖</h1>
            <p style="color:#888;font-size:14px;margin-top:6px">AI news made for kids</p>
          </div>

          <p style="font-size:16px;color:#333;line-height:1.7">
            Hey there! 👋 Welcome to <strong>Kids AI Buzz</strong> — your account is all set up and ready to go!
          </p>

          <div style="background:#F4F3FF;border-radius:16px;padding:1.5rem;margin:1.5rem 0">
            <h2 style="color:#7C6FF7;font-size:18px;margin:0 0 1rem">Here's what you can do 🎉</h2>
            <table style="width:100%;border-collapse:collapse">
              <tr>
                <td style="padding:8px 0;vertical-align:top;width:32px;font-size:20px">📰</td>
                <td style="padding:8px 0;color:#444;font-size:15px;line-height:1.5">
                  <strong>Read AI news daily</strong> — fresh stories every few hours, pulled from the web
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;vertical-align:top;font-size:20px">🎓</td>
                <td style="padding:8px 0;color:#444;font-size:15px;line-height:1.5">
                  <strong>3 reading levels</strong> — Young Explorer, Middle School, or Older Kid — pick what fits you
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;vertical-align:top;font-size:20px">🔍</td>
                <td style="padding:8px 0;color:#444;font-size:15px;line-height:1.5">
                  <strong>Search & filter</strong> — find stories by topic like Robots, Art, Science, and more
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;vertical-align:top;font-size:20px">🔥</td>
                <td style="padding:8px 0;color:#444;font-size:15px;line-height:1.5">
                  <strong>Streaks & badges</strong> — keep reading every day to build your streak and unlock badges
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;vertical-align:top;font-size:20px">📧</td>
                <td style="padding:8px 0;color:#444;font-size:15px;line-height:1.5">
                  <strong>Weekly digest</strong> — subscribe to get the top 5 stories sent to your inbox every week
                </td>
              </tr>
              <tr>
                <td style="padding:8px 0;vertical-align:top;font-size:20px">⭐</td>
                <td style="padding:8px 0;color:#444;font-size:15px;line-height:1.5">
                  <strong>Go Premium</strong> — unlock all stories at every reading level for just $3.99/month
                </td>
              </tr>
            </table>
          </div>

          <div style="text-align:center;margin:2rem 0">
            <a href="https://ai-news-buzz.onrender.com"
               style="display:inline-block;background:#7C6FF7;color:#fff;padding:14px 36px;border-radius:99px;text-decoration:none;font-weight:bold;font-size:16px">
              Start reading now →
            </a>
          </div>

          <p style="font-size:14px;color:#666;line-height:1.7">
            AI is changing the world fast — and we think every kid should know about it. Welcome aboard! 🚀
          </p>

          <hr style="border:none;border-top:1px solid #eee;margin:2rem 0">
          <p style="font-size:12px;color:#aaa;text-align:center">
            You're receiving this because you created an account at Kids AI Buzz.<br>
            <a href="https://ai-news-buzz.onrender.com/unsubscribe?email=${encodeURIComponent(email)}" style="color:#aaa">Unsubscribe</a>
          </p>
        </div>`
    });
    console.log(`📧 Signup welcome email sent to ${email}`);
  } catch(e) { console.warn('⚠ Signup welcome email failed:', e.message); }
}

async function sendPaidWelcomeEmail(email) {
  if (!mailer) { console.warn('⚠ sendPaidWelcomeEmail: Gmail not configured, skipping.'); return; }
  try {
    await mailer.sendMail({
      from: `"Kids AI Buzz" <${FROM}>`,
      to: email,
      subject: '🎉 You\'re subscribed to Kids AI Buzz!',
      html: `
        <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
          <h1 style="color:#7C6FF7;font-size:28px">You're in! 🚀</h1>
          <p style="font-size:16px;color:#444;line-height:1.6">
            Thanks for subscribing to <strong>Kids AI Buzz</strong>! You now have full access to all AI news stories at every reading level.
          </p>
          <p style="font-size:16px;color:#444;line-height:1.6">
            Every week we'll also send you a digest of the top AI stories — explained in a fun way kids actually understand. 🤖🎨🚀
          </p>
          <a href="https://ai-news-buzz.onrender.com"
             style="display:inline-block;background:#7C6FF7;color:#fff;padding:12px 28px;border-radius:99px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:1rem">
            Start reading →
          </a>
          <p style="font-size:13px;color:#999;margin-top:2rem">
            You're receiving this because you subscribed at Kids AI Buzz. Manage your subscription at any time from your account.
          </p>
        </div>`
    });
    console.log(`📧 Paid welcome email sent to ${email}`);
  } catch(e) { console.warn('⚠ Paid welcome email failed:', e.message); }
}

async function sendWeeklyDigest() {
  if (!mailer) { console.warn('⚠ sendWeeklyDigest: Gmail not configured, skipping.'); return; }
  const newsletterSubs = (db.get('newsletter').value() || []).map(s => s.email);
  const paidSubs = (db.get('users').filter({ subscriptionStatus: 'active' }).value() || []).map(u => u.email);
  const allEmails = [...new Set([...newsletterSubs, ...paidSubs])];
  if (!allEmails.length) return;

  const top5 = cache.articles
    .filter(a => a.levels?.middle?.summary)
    .slice(0, 5);
  if (!top5.length) return;

  const articlesHtml = top5.map((a, i) => `
    <div style="margin-bottom:1.5rem;padding-bottom:1.5rem;border-bottom:1px solid #eee">
      <div style="font-size:12px;font-weight:bold;color:#7C6FF7;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px">
        ${a.category}
      </div>
      <h3 style="margin:0 0 8px;color:#1A1035;font-size:18px">${a.headline}</h3>
      <p style="margin:0;color:#666;font-size:14px;line-height:1.6">${a.levels.middle.summary}</p>
    </div>`).join('');

  for (const email of allEmails) {
    try {
      await mailer.sendMail({
        from: '"Kids AI Buzz" <kidsaibuzz@gmail.com>',
        to: email,
        subject: `🤖 This week in AI — Kids AI Buzz`,
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:2rem">
            <h1 style="color:#7C6FF7;font-size:24px">This week in AI ✨</h1>
            <p style="color:#666;font-size:14px;margin-bottom:2rem">Here are the top 5 AI stories this week, explained just for you!</p>
            ${articlesHtml}
            <a href="https://ai-news-buzz.onrender.com"
               style="display:inline-block;background:#7C6FF7;color:#fff;padding:12px 28px;border-radius:99px;text-decoration:none;font-weight:bold;font-size:16px;margin-top:1rem">
              Read all stories →
            </a>
            <p style="font-size:13px;color:#999;margin-top:2rem">
              <a href="https://ai-news-buzz.onrender.com/unsubscribe?email=${encodeURIComponent(email)}" style="color:#999">Unsubscribe</a>
            </p>
          </div>`
      });
      console.log(`📧 Digest sent to ${email}`);
    } catch(e) { console.warn(`⚠ Digest failed for ${email}:`, e.message); }
  }
  console.log(`📧 Weekly digest attempted for ${allEmails.length} recipients`);
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

  sendSignupWelcomeEmail(email.toLowerCase());
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
      if(uid) {
        db.get('users').find({id:uid}).assign({ stripeCustomerId: customerId, subscriptionStatus:'active', subscriptionId: session.subscription }).write();
        const paidUser = db.get('users').find({id:uid}).value();
        if(paidUser?.email) sendPaidWelcomeEmail(paidUser.email);
      }
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

  // filter by category
  if(category !== 'all'){
    articles = articles.filter(a=>a.category===category);
  }

  // Cap free articles at 6 per category; subscribers see everything
  const catFreeCount = {};
  const allShaped = articles.map((a, i) => {
    const cat = a.category || 'cool';
    if (!catFreeCount[cat]) catFreeCount[cat] = 0;
    const isFree = subscribed || catFreeCount[cat] < 6;
    if (!subscribed && isFree) catFreeCount[cat]++;
    return {
      id:       a.id,
      headline: a.headline,
      category: a.category,
      pubDate:  a.pubDate,
      summary:  isFree ? (a.levels?.[level]?.summary || '') : (a.levels?.[level]?.summary || '').split('.')[0] + '...',
      full:     isFree ? (a.levels?.[level]?.full || '') : '',
      wow:      isFree ? (a.levels?.[level]?.wow || '') : '',
      locked:   !isFree,
    };
  });

  // Always show free articles before locked ones
  allShaped.sort((a, b) => (a.locked ? 1 : 0) - (b.locked ? 1 : 0));

  // paginate
  const start   = (page - 1) * pageSize;
  const sliced  = allShaped.slice(start, start + pageSize);
  const hasMore = start + pageSize < allShaped.length;

  res.json({ ok:true, count:sliced.filter(a=>!a.locked).length, total:cache.articles.length, page, hasMore, lastUpdated:cache.lastUpdated, isRefreshing:cache.isRefreshing, subscribed, articles:sliced });
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

/* ── POST /api/newsletter/subscribe ── */
app.post('/api/newsletter/subscribe', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  const existing = db.get('newsletter').find({ email: email.toLowerCase() }).value();
  if (existing) return res.json({ ok: true, message: 'Already subscribed!' });

  db.get('newsletter').push({ email: email.toLowerCase(), createdAt: new Date().toISOString() }).write();
  await sendWelcomeEmail(email.toLowerCase());
  res.json({ ok: true, message: 'Subscribed! Check your inbox.' });
});

/* ── GET /api/newsletter/unsubscribe ── */
app.get('/unsubscribe', (req, res) => {
  const email = req.query.email;
  if (email) {
    db.get('newsletter').remove({ email: email.toLowerCase() }).write();
    console.log(`📧 Unsubscribed: ${email}`);
  }
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:4rem"><h2>You\'ve been unsubscribed.</h2><p><a href="/">Back to Kids AI Buzz</a></p></body></html>');
});

/* ── POST /api/admin/digest ── (manual trigger) */
app.post('/api/admin/digest', async (req, res) => {
  if ((req.headers['x-admin-secret'] || req.body?.secret) !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  res.json({ ok: true, message: 'Digest sending...' });
  sendWeeklyDigest();
});

/* ── POST /api/admin/test-email ── */
app.post('/api/admin/test-email', async (req, res) => {
  if ((req.headers['x-admin-secret'] || req.body?.secret) !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const to = req.body?.to;
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Provide a "to" email address' });
  if (!mailer) return res.status(500).json({ error: 'Mailer not configured — GMAIL_APP_PASSWORD missing' });
  try {
    await mailer.sendMail({
      from: `"Kids AI Buzz" <${FROM}>`,
      to,
      subject: '✅ Test Email from Kids AI Buzz',
      html: `<p>Hey! If you're reading this, Nodemailer + Gmail is working correctly. 🎉</p>
             <p>Sent at: ${new Date().toISOString()}</p>`
    });
    res.json({ ok: true, message: `Test email sent to ${to}` });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* ── GET /robots.txt ── */
app.get('/robots.txt', (req, res) => {
  const base = process.env.APP_URL || 'https://ai-news-buzz.onrender.com';
  res.type('text/plain').send(
`User-agent: *
Allow: /

Sitemap: ${base}/sitemap.xml` 
  );
});

/* ── GET /sitemap.xml ── */
app.get('/sitemap.xml', (req, res) => {
  const base = process.env.APP_URL || 'https://ai-news-buzz.onrender.com';
  const urls = [
    { loc: base, priority: '1.0', changefreq: 'hourly' },
    { loc: `${base}/#pricing`, priority: '0.8', changefreq: 'monthly' },
    ...cache.articles.map(a => ({
      loc: `${base}/?article=${encodeURIComponent(a.headline||'')}`,
      priority: '0.6',
      changefreq: 'daily'
    }))
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u=>`  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
  res.header('Content-Type','application/xml').send(xml);
});

app.get('/streak', (_,res) => res.sendFile(path.join(__dirname,'public','streak.html')));
app.get('*', (_,res) => res.sendFile(path.join(__dirname,'public','index.html')));

/* ═══════════════════════════════════════════════
   STARTUP
═══════════════════════════════════════════════ */
app.listen(PORT, async () => {
  console.log(`\n🚀 Kids AI Buzz → http://localhost:${PORT}`);
  console.log(`💳 Stripe enabled: ${!!process.env.STRIPE_SECRET_KEY}`);
  console.log(`📡 ${RSS_FEEDS.length} RSS feeds | 🔄 Cron: ${REFRESH_CRON}\n`);

  // only refresh on startup if cache exists and is stale — never on a fresh deploy
  const cacheAge = cache.lastUpdated ? (Date.now() - new Date(cache.lastUpdated)) : Infinity;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  if (cache.articles.length > 0 && cacheAge > TWENTY_FOUR_HOURS) {
    console.log('🔄 Cache is stale — refreshing...');
    await refreshNews();
  } else if (cache.articles.length === 0) {
    console.log('⏳ No cache on disk — waiting for first cron tick to refresh');
  } else {
    console.log(`✅ Using cached articles (${cache.articles.length} articles, ${Math.round(cacheAge/60000)}m old)`);
  }

  cron.schedule(REFRESH_CRON, () => { console.log('[cron] Refresh'); refreshNews(); });
  cron.schedule('0 9 * * 1', () => { console.log('[cron] Weekly digest'); sendWeeklyDigest(); });
});