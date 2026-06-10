require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const compression = require('compression');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const cron        = require('node-cron');
// rss-parser removed — using NewsAPI instead
const axios = require('axios');
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
let gemini = null;
if (genAI) {
  // Try models in order of preference — first one that exists wins
  const CANDIDATE_MODELS = [
    'gemini-2.5-flash',
    'gemini-2.5-flash-preview-05-20',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
  ];
  (async () => {
    for (const model of CANDIDATE_MODELS) {
      try {
        const m = genAI.getGenerativeModel({ model });
        await m.generateContent({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] });
        gemini = m;
        console.log(`✅ Gemini model: ${model}`);
        break;
      } catch (e) {
        if (e.status === 404) { console.log(`   ✗ ${model} not available`); continue; }
        // 429 = quota hit but model exists — use it anyway
        gemini = genAI.getGenerativeModel({ model });
        console.log(`✅ Gemini model: ${model} (quota currently limited)`);
        break;
      }
    }
    if (!gemini) console.warn('⚠ No working Gemini model found — will serve raw articles');
  })();
}
const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY) : null;
if (!process.env.GMAIL_APP_PASSWORD) { console.warn('⚠ GMAIL_APP_PASSWORD not set — emails disabled'); }
const mailer = process.env.GMAIL_APP_PASSWORD
  ? nodemailer.createTransport({
      service: 'gmail',
      auth: { user: 'kidsaibuzz@gmail.com', pass: process.env.GMAIL_APP_PASSWORD }
    })
  : null;
const FROM   = 'kidsaibuzz@gmail.com';
if (!process.env.NEWS_API_KEY) { console.warn('⚠ NEWS_API_KEY not set — cannot fetch articles'); }

/* ═══════════════════════════════════════════════
   NEWSAPI QUERIES — one per category
═══════════════════════════════════════════════ */
const NEWSAPI_QUERIES = [
  { q: 'artificial intelligence',        label: 'AI'       },
  { q: 'machine learning deep learning', label: 'ML'       },
  { q: 'robotics robot humanoid',        label: 'Robots'   },
  { q: 'AI art image generation',        label: 'AI Art'   },
  { q: 'space NASA rocket astronomy',    label: 'Space'    },
  { q: 'AI science medical research',    label: 'Science'  },
  { q: 'AI gaming video games',          label: 'Gaming'   },
  { q: 'wildlife animals nature',        label: 'Animals'  },
  { q: 'OpenAI GPT Gemini LLM',          label: 'LLMs'     },
  { q: 'drone autonomous self-driving',  label: 'Drones'   },
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
function cleanText(text, maxLen) {
  if (!text) return '';
  let t = text
    .replace(/<[^>]+>/g, ' ')           // strip HTML
    .replace(/\[\+\d+ chars?\]/gi, '')   // remove [+10695 chars]
    .replace(/\s+/g, ' ')               // collapse whitespace
    .trim();
  if (maxLen && t.length > maxLen) {
    // cut at last sentence boundary before maxLen
    const cut = t.slice(0, maxLen);
    const lastDot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = lastDot > maxLen * 0.5 ? cut.slice(0, lastDot + 1) : cut + '…';
  }
  return t;
}

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

/* ── fetch articles from NewsAPI ── */
async function scrapeAllFeeds() {
  if (!process.env.NEWS_API_KEY) {
    console.warn('⚠ NEWS_API_KEY not set — skipping fetch');
    return [];
  }

  console.log('📡 Fetching stories from NewsAPI...');

  const results = await Promise.allSettled(
    NEWSAPI_QUERIES.map(({ q, label }) =>
      axios.get('https://newsapi.org/v2/everything', {
        timeout: 10000,
        params: {
          q,
          language: 'en',
          sortBy: 'publishedAt',
          pageSize: 20,
          apiKey: process.env.NEWS_API_KEY,
        },
      }).then(r => {
        const articles = (r.data.articles || [])
          .filter(a => a.title && a.title !== '[Removed]' && a.url)
          .map(a => ({
            title:   a.title.trim(),
            link:    a.url,
            pubDate: a.publishedAt,
            source:  a.source?.name || label,
            snippet: cleanText(a.description || a.content || '', 600),
            body:    cleanText(a.content || a.description || '', 3000),
          }));
        console.log(`   ✓ ${label}: ${articles.length} articles`);
        return articles;
      }).catch(e => {
        console.warn(`   ⚠ ${label}: ${e.response?.data?.message || e.message}`);
        return [];
      })
    )
  );

  const all = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value)
    .filter(a => a.title?.length > 15);

  // deduplicate by URL and title
  const seenUrls = new Set(), seenTitles = new Set(), dedup = [];
  for (const item of all) {
    const urlKey   = item.link ? (() => { try { const u = new URL(item.link); return u.hostname + u.pathname; } catch { return item.link; } })() : '';
    const titleKey = item.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 60);
    if ((urlKey && seenUrls.has(urlKey)) || seenTitles.has(titleKey)) continue;
    if (urlKey) seenUrls.add(urlKey);
    seenTitles.add(titleKey);
    dedup.push(item);
  }

  dedup.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  const top = dedup.slice(0, 200);
  console.log(`   → ${top.length} stories found`);
  console.log(`   → ${top.filter(a => a.body?.length > 100).length} articles with content`);
  return top;
}

/* ── fetch & extract plain text from an article URL ── */
async function fetchFullArticle(url) {
  try {
    const res = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; KidsAIBuzz/1.0)',
        'Accept': 'text/html',
      },
      maxContentLength: 2 * 1024 * 1024,
    });
    const html = res.data || '';
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(nav|header|footer|aside|figure|figcaption|form|button|iframe|noscript)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "\'")
      .replace(/\s{2,}/g, ' ')
      .trim();
    return stripped.length > 200 ? stripped.slice(0, 8000) : null;
  } catch (e) {
    console.warn(`   ⚠ fetchFullArticle(${url}): ${e.message}`);
    return null;
  }
}

async function rewriteForKids(rawArticles) {
  if(!rawArticles.length) return [];

  // If Gemini is not configured, serve raw articles directly so the site is never blank
  if (!gemini) {
    console.log('📰 No Gemini key — serving raw articles directly');
    return rawArticles.slice(0, 60).map(a => ({
      id: Date.now() + Math.random(),
      headline: a.title,
      category: detectCategory(a.title, a.body || a.snippet || ''),
      source: a.source,
      link: a.link,
      pubDate: a.pubDate,
      levels: {
        young:  { summary: cleanText(a.snippet || a.body || a.title, 400), full: cleanText(a.body || a.snippet || a.title, 1500), wow: 'Scientists are making amazing discoveries every day!' },
        middle: { summary: cleanText(a.snippet || a.body || a.title, 600), full: cleanText(a.body || a.snippet || a.title, 1800), wow: 'Researchers around the world are working on this.' },
        older:  { summary: cleanText(a.snippet || a.body || a.title, 800), full: cleanText(a.body || a.snippet || a.title, 2000), wow: 'This represents a significant development in the field.' },
      },
    }));
  }

  // only rewrite first 6 articles per refresh — stays well within Gemini free tier (25 RPD)
  const toRewrite = rawArticles.slice(0, 6);
  console.log(`✍️  Rewriting ${toRewrite.length} articles...`);

  // Fetch full article text for each — run in parallel with a 3s stagger to be polite
  console.log('🌐 Fetching full article text...');
  for (let i = 0; i < toRewrite.length; i++) {
    const full = await fetchFullArticle(toRewrite[i].link);
    if (full) {
      toRewrite[i].fullText = full;
      console.log(`   ✓ [${i+1}] fetched ${full.length} chars — ${toRewrite[i].title.slice(0, 60)}`);
    } else {
      console.warn(`   ⚠ [${i+1}] fallback to snippet — ${toRewrite[i].title.slice(0, 60)}`);
    }
    if (i < toRewrite.length - 1) await new Promise(r => setTimeout(r, 300));
  }

  const BATCH=3; const results=[];
  let dailyQuotaExhausted = false;

  for(let i=0;i<toRewrite.length;i+=BATCH){
    if(dailyQuotaExhausted) break;
    const batch=toRewrite.slice(i,i+BATCH);
    const startId=i+1;
    const articleList=batch.map((a,j)=>{
      const content = a.fullText || a.body || a.snippet || 'No content available';
      return `[${startId+j}] Title: ${a.title}\nContent:\n${content}`;
    }).join('\n\n---\n\n');
    const prompt=`You are a fun kids science writer for a magazine. Write completely original kid-friendly articles based on the stories below. Do NOT credit any source.

${articleList}

Return ONLY a valid JSON array (no markdown, no extra text).
Each object must have exactly:
{
  "id": <number>,
  "headline": "fun title max 10 words",
  "category": "robots|art|science|gaming|animals|space|cool",
  "levels": {
    "young":  { "summary": "One flowing paragraph (~2000 characters) written for age 7. Use very simple, fun words. Tell the whole story — what happened, why it's cool, and what it means. No bullet points, just one readable paragraph.", "full": "5 paragraphs for age 7, each 3-4 sentences. Use very simple fun words. Separate every paragraph with \\n\\n", "wow": "surprising fact max 10 words" },
    "middle": { "summary": "One flowing paragraph (~2000 characters) written for age 10. Cover what happened, why it matters, how it works, and what comes next. No bullet points, just one readable paragraph.", "full": "7 paragraphs for age 10, each 4-5 sentences. Include what happened, why it matters, how it works, who did it, cool details, and what comes next. Separate every paragraph with \\n\\n", "wow": "interesting fact max 14 words" },
    "older":  { "summary": "One flowing paragraph (~2000 characters) written for age 13. Include background, what happened, technical details, real-world impact, and future implications. No bullet points, just one readable paragraph.", "full": "9 paragraphs for age 13, each 4-6 sentences. Include background, what happened, technical details, expert reactions, real world impact, comparisons, and future implications. Separate every paragraph with \\n\\n", "wow": "insightful fact max 18 words" }
  }
}
CRITICAL rules:
- summary fields must be a single continuous paragraph of ~2000 characters — not bullet points, not multiple paragraphs
- paragraphs in "full" MUST be separated by \\n\\n
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
        const result = await Promise.race([
          gemini.generateContent(prompt),
          new Promise((_,rej) => setTimeout(() => rej(new Error('Gemini timeout after 60s')), 60000)),
        ]);
        let text = result.response.text();
        text = text.split('\n').filter(l => !l.startsWith('```')).join('\n').trim();
        const s=text.indexOf('['),e=text.lastIndexOf(']');
        if(s===-1||e===-1) throw new Error('No JSON array');
        const rw=JSON.parse(text.slice(s,e+1));
        for(const r of rw){
          const raw=toRewrite[r.id-1]; if(!raw) continue;
          results.push({ id: Date.now()+r.id, headline:r.headline, category:r.category||detectCategory(raw.title,raw.body||''), source:raw.source, link:raw.link, pubDate:raw.pubDate, levels:r.levels });
        }
        console.log(`   ✓ Batch ${Math.floor(i/BATCH)+1} done (${rw.length} articles)`);
        // 15 second delay between batches to respect 5 RPM limit
        if(i+BATCH < toRewrite.length) await new Promise(r=>setTimeout(r,15000));
        break;
      } catch(err) {
        const msg = err.message || '';
        const batchNum = Math.floor(i/BATCH)+1;
        console.warn(`   ⚠ Batch ${batchNum} attempt ${attempt+1} failed: ${msg.slice(0,200)}`);
        if (err.status || err.statusText) console.warn(`   ⚠ HTTP status: ${err.status} ${err.statusText}`);

        if(msg.includes('PerDay') || (msg.includes('limit: 0') && msg.includes('Per'))){
          console.warn('   ✖ Daily Gemini quota exhausted — skipping remaining batches');
          dailyQuotaExhausted = true;
          break;
        }

        if(attempt===2){
          for(const a of batch){
            results.push({ id:Date.now()+Math.random(), headline:a.title, category:detectCategory(a.title,a.body||''), source:a.source, link:a.link, pubDate:a.pubDate,
              levels:{ young:{summary:a.title,full:a.body?.slice(0,400)||a.title,wow:'Scientists made a cool discovery!'}, middle:{summary:a.title,full:a.body?.slice(0,600)||a.title,wow:'Researchers worked hard on this project.'}, older:{summary:a.title,full:a.body?.slice(0,800)||a.title,wow:'This represents a significant technical achievement.'} }
            });
          }
        } else {
          const delayMatch = msg.match(/retry in (\d+(?:\.\d+)?)s/i);
          const waitMs = delayMatch ? Math.min(Math.ceil(parseFloat(delayMatch[1])) * 1000, 60000) : 15000;
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

    // If scraping returned nothing (all feeds blocked), keep old cache rather than going blank
    if (!raw || raw.length === 0) {
      console.warn('⚠ Scraping returned 0 articles — keeping existing cache intact');
      cache.isRefreshing = false;
      return;
    }

    let rewritten = await rewriteForKids(raw);
    if (!rewritten || !rewritten.length) {
      console.warn('⚠ Gemini rewriting failed — serving raw articles directly');
      rewritten = raw.slice(0, 60).map(a => ({
        id: Date.now() + Math.random(),
        headline: a.title,
        category: detectCategory(a.title, a.body || a.snippet || ''),
        source: a.source,
        link: a.link,
        pubDate: a.pubDate,
        levels: {
          young:  { summary: cleanText(a.snippet || a.body || a.title, 400), full: cleanText(a.body || a.snippet || a.title, 1500), wow: 'Scientists are making amazing discoveries every single day!' },
          middle: { summary: cleanText(a.snippet || a.body || a.title, 600), full: cleanText(a.body || a.snippet || a.title, 1800), wow: 'Researchers around the world are working on this.' },
          older:  { summary: cleanText(a.snippet || a.body || a.title, 800), full: cleanText(a.body || a.snippet || a.title, 2000), wow: 'This represents a significant development in this field.' },
        },
      }));
    }

    const CATS = ['robots','art','science','gaming','animals','space','cool'];
    const byCategory = {};
    CATS.forEach(c => byCategory[c] = []);
    for(const a of rewritten){
      const c = a.category || 'cool';
      if(!byCategory[c]) byCategory[c] = [];
      byCategory[c].push(a);
    }

    const sortedBySize = [...CATS].sort((a,b) => byCategory[a].length - byCategory[b].length);
    let overflow = rewritten.filter(a => byCategory[a.category]?.length > 12);
    for(const c of sortedBySize){
      while(byCategory[c].length < 12 && overflow.length){
        const extra = overflow.shift();
        byCategory[c].push({...extra, category: c});
      }
    }

    const final = [];
    for(let i=0;i<12;i++){
      CATS.forEach(c => { if(byCategory[c][i]) final.push(byCategory[c][i]); });
    }

    const existingIds = new Set((cache.articles||[]).map(a=>a.id||a.headline));
    const brandNew = final.filter(a => !existingIds.has(a.id||a.headline));
    const merged = [...brandNew, ...(cache.articles||[])].slice(0, 500);

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
                  <strong>Read AI news daily</strong> — fresh stories every day, pulled from the web
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

app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use('/api/', rateLimit({ windowMs:15*60*1000, max:120, standardHeaders:true, legacyHeaders:false }));
app.use(express.static(path.join(__dirname,'public')));

/* ─── AUTH ROUTES ─────────────────────────────── */

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

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.get('users').find({ email: email?.toLowerCase() }).value();
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const match = await bcrypt.compare(password, user.passwordHash);
  if (!match) return res.status(401).json({ error: 'Invalid email or password' });

  res.json({ token: signToken(user.id), email: user.email, subscribed: user.subscriptionStatus === 'active' });
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  const user = db.get('users').find({ id: req.user.id }).value();
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ email: user.email, subscribed: user.subscriptionStatus === 'active', status: user.subscriptionStatus });
});

/* ─── STRIPE ROUTES ───────────────────────────── */

app.post('/api/stripe/checkout', authMiddleware, async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Payments not configured' });
  const PROMO_COUPON_ID = process.env.STRIPE_PROMO_COUPON_ID;
  const promoRequested = req.body?.usePromo === true;
  const isPromo = promoRequested && !!PROMO_COUPON_ID && new Date() < new Date('2026-06-29T00:00:00Z');
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

app.post('/api/stripe/webhook', (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Payments not configured' });
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { console.error('Webhook error:', e.message); return res.status(400).send(`Webhook Error: ${e.message}`); }

  const session      = event.data.object;
  const customerId   = session.customer;

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
      const status = event.data.object.status;
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
  const pageSize = 18;

  let subscribed = false;
  const header = req.headers.authorization || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if(token) {
    try { const decoded=jwt.verify(token,JWT_SECRET); subscribed=isSubscribed(decoded.id); } catch{}
  }

  let articles = cache.articles;

  if(category !== 'all'){
    articles = articles.filter(a=>a.category===category);
  }

  const catFreeCount = {};
  const allShaped = articles.map((a, i) => {
    const cat = a.category || 'cool';
    if (!catFreeCount[cat]) catFreeCount[cat] = 0;
    const isFree = subscribed || catFreeCount[cat] < 2;
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

  allShaped.sort((a, b) => (a.locked ? 1 : 0) - (b.locked ? 1 : 0));

  const start   = (page - 1) * pageSize;
  const sliced  = allShaped.slice(start, start + pageSize);
  const hasMore = start + pageSize < allShaped.length;

  res.json({ ok:true, count:sliced.filter(a=>!a.locked).length, total:cache.articles.length, page, hasMore, lastUpdated:cache.lastUpdated, isRefreshing:cache.isRefreshing, subscribed, articles:sliced });
});

/* ─── STATUS / ADMIN ──────────────────────────── */
app.get('/api/promo', (req, res) => {
  const isPromo = !!process.env.STRIPE_PROMO_COUPON_ID && new Date() < new Date('2026-06-29T00:00:00Z');
  res.json({ isPromo, promoPrice: '1.99', regularPrice: '3.99', promoEnds: '2026-06-29' });
});

app.get('/api/status', (req,res) => res.json({ ok:true, articleCount:cache.articles.length, lastUpdated:cache.lastUpdated, isRefreshing:cache.isRefreshing, users:db.get('users').size().value() }));

app.post('/api/admin/refresh', (req,res) => {
  if((req.headers['x-admin-secret']||req.body?.secret)!==ADMIN_SECRET) return res.status(403).json({error:'Forbidden'});
  res.json({ok:true,message:'Refresh started.'}); refreshNews();
});

app.post('/api/newsletter/subscribe', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Invalid email' });

  const existing = db.get('newsletter').find({ email: email.toLowerCase() }).value();
  if (existing) return res.json({ ok: true, message: 'Already subscribed!' });

  db.get('newsletter').push({ email: email.toLowerCase(), createdAt: new Date().toISOString() }).write();
  await sendWelcomeEmail(email.toLowerCase());
  res.json({ ok: true, message: 'Subscribed! Check your inbox.' });
});

app.get('/unsubscribe', (req, res) => {
  const email = req.query.email;
  if (email) {
    db.get('newsletter').remove({ email: email.toLowerCase() }).write();
    console.log(`📧 Unsubscribed: ${email}`);
  }
  res.send('<html><body style="font-family:sans-serif;text-align:center;padding:4rem"><h2>You\'ve been unsubscribed.</h2><p><a href="/">Back to Kids AI Buzz</a></p></body></html>');
});

app.post('/api/admin/digest', async (req, res) => {
  if ((req.headers['x-admin-secret'] || req.body?.secret) !== ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  res.json({ ok: true, message: 'Digest sending...' });
  sendWeeklyDigest();
});

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

app.get('/robots.txt', (req, res) => {
  const base = process.env.APP_URL || 'https://ai-news-buzz.onrender.com';
  res.type('text/plain').send(
`User-agent: *
Allow: /

Sitemap: ${base}/sitemap.xml`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const base = process.env.APP_URL || 'https://ai-news-buzz.onrender.com';
  const urls = [
    { loc: base, priority: '1.0', changefreq: 'daily' },
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
  console.log(`📡 ${NEWSAPI_QUERIES.length} NewsAPI queries | 🔄 Cron: ${REFRESH_CRON}\n`);

  const cacheAge = cache.lastUpdated ? (Date.now() - new Date(cache.lastUpdated)) : Infinity;
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;

  if (cache.articles.length > 0 && cacheAge > TWENTY_FOUR_HOURS) {
    console.log('🔄 Cache is stale — refreshing...');
    refreshNews();
  } else if (cache.articles.length === 0) {
    // Fresh deploy — start fetching immediately so the site is never empty
    console.log('🆕 No cache found — fetching articles now...');
    refreshNews();
  } else {
    console.log(`✅ Using cached articles (${cache.articles.length} articles, ${Math.round(cacheAge/60000)}m old)`);
  }

  cron.schedule(REFRESH_CRON, () => { console.log('[cron] Refresh'); refreshNews(); });
  cron.schedule('0 9 * * 1', () => { console.log('[cron] Weekly digest'); sendWeeklyDigest(); });
});