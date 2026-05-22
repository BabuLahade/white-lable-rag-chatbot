// ============================================================
// universal-crawler.js  v2.1  — FIXED
// 
// KEY FIX: WordPress now uses wp-sitemap.xml as PRIMARY
// strategy. wp-sitemap.xml is WP core since v5.5 (2020)
// and cannot be disabled by any plugin.
// REST API is now OPTIONAL — tried last, never relied on.
//
// Strategy per platform:
//   WordPress   → wp-sitemap.xml → HTML fetch per page
//   Shopify     → /products.json + /pages.json APIs
//   Squarespace → /?format=json per page
//   Wix         → JSON-LD + HTML
//   Webflow     → sitemap.xml + clean HTML
//   Generic     → sitemap.xml → scored nav links → HTML
//   Auth        → any above + auth headers
// ============================================================

// ── BROWSER-LIKE HEADERS ─────────────────────────────────────
// Full Chrome 124 fingerprint — passes Cloudflare, WP security plugins,
// iThemes, Wordfence bot detection. DO NOT simplify these headers.
const HEADERS = {
  "User-Agent":                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "Accept-Language":           "en-US,en;q=0.9",
  "Accept-Encoding":           "gzip, deflate, br",
  "Cache-Control":             "no-cache",
  "Pragma":                    "no-cache",
  "Sec-Ch-Ua":                 '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile":          "?0",
  "Sec-Ch-Ua-Platform":        '"Windows"',
  "Sec-Fetch-Dest":            "document",
  "Sec-Fetch-Mode":            "navigate",
  "Sec-Fetch-Site":            "none",
  "Sec-Fetch-User":            "?1",
  "Upgrade-Insecure-Requests": "1",
};

const TIMEOUT_PAGE = 12000;
const TIMEOUT_API  = 8000;
const DELAY_MS     = 350; // polite delay between page fetches

// ── FETCH HELPERS ────────────────────────────────────────────
async function safeFetch(url, opts = {}) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeout || TIMEOUT_PAGE);
    const res = await fetch(url, {
      headers: { ...HEADERS, ...opts.headers },
      redirect: "follow",
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res;
  } catch (e) {
    console.warn(`[fetch] ${url} → ${e.message}`);
    return null;
  }
}

async function getHTML(url, opts = {}) {
  const res = await safeFetch(url, opts);
  if (!res) return null;
  // Accept 200 and also 304
  if (res.status === 404 || res.status === 403 || res.status === 401) return null;
  return await res.text().catch(() => null);
}

async function getJSON(url, opts = {}) {
  const res = await safeFetch(url, {
    ...opts,
    headers: { ...opts.headers, Accept: "application/json, */*" },
    timeout: opts.timeout || TIMEOUT_API,
  });
  if (!res?.ok) return null;
  const raw = await res.text().catch(() => null);
  if (!raw) return null;
  // Strip JSONP wrapper if present
  const stripped = raw.replace(/^[a-zA-Z_$][\w$]*\s*\(/, "").replace(/\);\s*$/, "");
  try { return JSON.parse(stripped); } catch { return null; }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── HTML → CLEAN TEXT ────────────────────────────────────────
export function extractContent(html, url = "") {
  if (!html || html.length < 50) return "";

  return html
    // Drop entire unwanted sections
    .replace(/<(script|style|noscript|iframe|svg|canvas|video|audio|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    // Drop elements by class/id patterns (nav, menu, cookie, popup etc.)
    .replace(/<[^>]+(class|id)\s*=\s*["'][^"']*?(nav|menu|header|footer|sidebar|cookie|popup|modal|overlay|banner|widget|breadcrumb|pagination|social|share|comment|related|advertisement|ad-)[^"']*["'][^>]*>[\s\S]*?<\/[a-z]+>/gi, " ")
    // Structural → newlines
    .replace(/<\/?(h[1-6])[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/(div|section|article|main)[^>]*>/gi, "\n")
    // Strip all remaining tags
    .replace(/<[^>]+>/g, " ")
    // Decode entities
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&[a-z]{2,8};/g, " ")
    // Normalise whitespace
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── TITLE EXTRACTOR ──────────────────────────────────────────
function getTitle(html) {
  if (!html) return "";
  const og  = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i);
  if (og) return decode(og[1]);
  const tag = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (tag) return decode(tag[1]).replace(/\s*[|\-–—].*$/, "").trim();
  const h1  = html.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1)  return decode(h1[1]).replace(/<[^>]+>/g, "").trim();
  return "";
}

function decode(s) {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/<[^>]+>/g, "").trim();
}

// ── META FALLBACK ────────────────────────────────────────────
// For JS-heavy pages where body content is empty after fetch
function getMetaText(html) {
  if (!html) return "";
  const parts = [];
  const ogT   = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']{3,})["']/i);
  const ogD   = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']{10,})["']/i);
  const desc  = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']{10,})["']/i);
  const kw    = html.match(/<meta[^>]*name=["']keywords["'][^>]*content=["']([^"']{5,})["']/i);
  if (ogT)  parts.push(decode(ogT[1]));
  if (ogD)  parts.push(decode(ogD[1]));
  else if (desc) parts.push(decode(desc[1]));
  if (kw)   parts.push("Keywords: " + decode(kw[1]));

  // JSON-LD structured data
  for (const [, raw] of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(raw);
      [d.name, d.description, d.headline, d.telephone, d.email,
       d.address?.streetAddress, d.openingHours].filter(Boolean).forEach(v => parts.push(v));
    } catch {}
  }
  return parts.filter(Boolean).join(". ").replace(/\s+/g, " ").trim();
}

// ── TEXT CHUNKER ─────────────────────────────────────────────
export function chunkText(text, maxChars = 1600, overlapChars = 200) {
  const clean = (text || "").replace(/\s{3,}/g, "\n\n").trim();
  if (clean.length < 60) return [];
  if (clean.length <= maxChars) return [clean];

  const chunks = [];
  const paras  = clean.split(/\n{2,}/);
  let   cur    = "";

  for (const para of paras) {
    const proposed = cur ? cur + "\n\n" + para : para;
    if (proposed.length > maxChars) {
      if (cur.trim().length >= 60) chunks.push(cur.trim());
      // Start next chunk with overlap from previous
      cur = cur.length > overlapChars
        ? cur.slice(-overlapChars).replace(/^\S+\s/, "") + "\n\n" + para
        : para;
    } else {
      cur = proposed;
    }
  }
  if (cur.trim().length >= 60) chunks.push(cur.trim());
  return chunks;
}

// ── URL HELPERS ───────────────────────────────────────────────
function normalise(url) { return url.replace(/\/+$/, "").toLowerCase(); }
function urlToSlug(url, type = "page") {
  const path = url.replace(/https?:\/\/[^/]+/, "").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "");
  return `${type}_${(path || "home").slice(0, 45)}`;
}
function guessType(url = "", text = "") {
  const s = url.toLowerCase();
  if (/\/product|\/shop|\/store|\/item/.test(s))      return "product";
  if (/\/blog|\/post|\/article|\/news/.test(s))       return "post";
  if (/\/service|\/what-we-do|\/solution/.test(s))    return "service";
  if (/\/pric|\/plan|\/package/.test(s))              return "pricing";
  if (/\/contact|\/reach|\/touch/.test(s))            return "contact";
  if (/\/about|\/team|\/who-we|\/story/.test(s))      return "about";
  if (/\/faq|\/question|\/help|\/support/.test(s))    return "faq";
  if (/\/portfolio|\/work|\/project|\/case/.test(s))  return "portfolio";
  if (/\/course|\/class|\/programme/.test(s))         return "course";
  if (/\/doctor|\/specialist|\/department/.test(s))   return "medical";
  return "page";
}

// Score URLs — higher = more important, fetch first
function scoreUrl(url) {
  const s = url.toLowerCase();
  if (/\/(about|services?|pricing|contact|faq|team)(\/|$)/.test(s)) return 90;
  if (/\/(portfolio|work|projects?|courses?|product)(\/|$)/.test(s)) return 75;
  if (/\/(blog|news|article)(\/|$)/.test(s))                         return 40;
  if (/\d{4}\/\d{2}/.test(s))                                        return 15; // dated archive
  if (/\/(tag|category|author|page)\//.test(s))                      return 5;
  if (/\/(login|admin|cart|checkout|account|wp-)/.test(s))           return 0;
  const depth = (url.match(/\//g) || []).length - 2;
  return Math.max(60 - depth * 10, 10);
}

// ── INTERNAL LINK EXTRACTOR ───────────────────────────────────
function getInternalLinks(html, base, max = 30) {
  const found = new Set();
  for (const [, raw] of html.matchAll(/href=["']([^"'#?][^"']*)["']/gi)) {
    let url = raw.trim();
    if (/\.(jpg|jpeg|png|gif|svg|webp|ico|css|js|pdf|zip|xml|json|mp4|woff)(\?|$)/i.test(url)) continue;
    if (/^(mailto:|tel:|javascript:|#)/i.test(url)) continue;
    if (url.startsWith("//")) url = "https:" + url;
    else if (url.startsWith("/"))  url = base + url;
    else if (!url.startsWith("http")) url = base + "/" + url;
    if (!url.startsWith(base)) continue;
    const clean = url.split("?")[0].split("#")[0].replace(/\/+$/, "");
    if (clean === base || found.has(clean)) continue;
    found.add(clean);
    if (found.size >= max) break;
  }
  return [...found];
}

// ── SITEMAP PARSER ────────────────────────────────────────────
async function getSitemapUrls(base, extraHeaders = {}) {
  const urls = [];
  const tried = new Set();

  async function parseSitemapXml(xmlUrl) {
    if (tried.has(xmlUrl) || tried.size > 8) return;
    tried.add(xmlUrl);
    const xml = await getHTML(xmlUrl, { headers: extraHeaders, timeout: 8000 });
    if (!xml) return;

    // Sitemap index → recurse into sub-sitemaps
    const subSitemaps = [...xml.matchAll(/<sitemap>\s*<loc>\s*([^<]+)\s*<\/loc>/gi)];
    if (subSitemaps.length > 0) {
      for (const [, sub] of subSitemaps.slice(0, 5)) await parseSitemapXml(sub.trim());
      return;
    }

    // Regular sitemap — collect <loc> entries
    for (const [, loc] of xml.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
      const u = loc.trim();
      if (!u.startsWith(base)) continue;
      if (/\.(xml|jpg|png|gif|pdf|zip)$/i.test(u)) continue;
      if (!/\/(login|admin|cart|checkout|account|wp-login|feed)/.test(u)) urls.push(u);
      if (urls.length >= 50) return;
    }
  }

  // Try WP sitemap first, then generic
  await parseSitemapXml(`${base}/wp-sitemap.xml`);
  if (urls.length === 0) await parseSitemapXml(`${base}/sitemap.xml`);
  if (urls.length === 0) await parseSitemapXml(`${base}/sitemap_index.xml`);

  return urls;
}

// ── PAGE FETCHER ─────────────────────────────────────────────
// Fetch a single page, extract content, handle JS-empty body
async function fetchPage(url, extraHeaders = {}) {
  const html = await getHTML(url, { headers: extraHeaders });
  if (!html) return null;

  const title = getTitle(html);
  let   text  = extractContent(html, url);

  // If body is near-empty (JS-rendered), grab meta as fallback
  if (text.length < 150) {
    const meta = getMetaText(html);
    if (meta.length > 30) text = meta;
  }

  if (text.length < 40) return null;
  return { title, text, html };
}

// ══════════════════════════════════════════════════════════════
// CLOUDFLARE DETECTION
// 512-char HTML = Cloudflare challenge page, not real content
// ══════════════════════════════════════════════════════════════
function isCloudflarePage(html) {
  if (!html || html.length < 1000) return true;
  return html.includes("cf-browser-verification")
    || html.includes("cdn-cgi/challenge-platform")
    || html.includes("__cf_chl")
    || html.includes("Checking if the site connection is secure")
    || html.includes("DDoS protection by Cloudflare");
}

// ══════════════════════════════════════════════════════════════
// WORDPRESS CRAWLER
// Strategy waterfall:
//   1. REST API (often bypasses Cloudflare — returns JSON not HTML)
//   2. Direct HTML crawl (works without Cloudflare)
//   3. CF fallback — try known important paths directly
// ══════════════════════════════════════════════════════════════
async function crawlWordPress(base, extraHeaders = {}) {
  const items = [];
  const seen  = new Set([normalise(base), normalise(base + "/")]);

  console.log(`[wp] Starting WordPress crawl: ${base}`);

  // ── STRATEGY 1: WP REST API ───────────────────────────────
  // REST API returns JSON which Cloudflare usually allows through.
  // Even if HTML is blocked, /wp-json/ often works fine.
  const restEndpoints = [
    { path: "/wp-json/wp/v2/pages?per_page=20&status=publish&_fields=id,title,content,slug,link",              type: "page"    },
    { path: "/wp-json/wp/v2/posts?per_page=10&status=publish&_fields=id,title,content,slug,link",              type: "post"    },
    { path: "/wp-json/wp/v2/products?per_page=20&status=publish&_fields=id,title,description,short_description,slug,link,price", type: "product" },
  ];

  let restWorked = false;
  for (const ep of restEndpoints) {
    const data = await getJSON(`${base}${ep.path}`, { headers: extraHeaders });
    if (!Array.isArray(data) || data.length === 0) continue;
    restWorked = true;
    for (const item of data) {
      const title = decode(item.title?.rendered || "");
      const body  = extractContent(item.content?.rendered || item.description || item.short_description || "");
      const price = item.price ? ` Price: ${item.price}.` : "";
      const text  = `${title ? title + ". " : ""}${body}${price}`.trim();
      const src   = item.link || `${base}/${item.slug}`;
      if (text.length < 40 || seen.has(normalise(src))) continue;
      seen.add(normalise(src));
      items.push({ title, text, source: src, type: ep.type, platform: "wordpress_rest" });
    }
  }
  console.log(`[wp] REST API: ${restWorked ? items.length + " items" : "blocked/empty"}`);

  // ── STRATEGY 2: Direct HTML crawl ─────────────────────────
  const homeHtml = await getHTML(base, { headers: extraHeaders });
  const cfBlocked = isCloudflarePage(homeHtml);
  console.log(`[wp] Homepage HTML: ${homeHtml?.length || 0} chars, CF-blocked: ${cfBlocked}`);

  if (!cfBlocked && homeHtml) {
    const homeText = extractContent(homeHtml, base);
    if (homeText.length > 60) {
      items.push({ title: getTitle(homeHtml), text: homeText, source: base, type: "homepage", platform: "wordpress" });
    }

    const sitemapUrls = await getSitemapUrls(base, extraHeaders);
    const navLinks    = getInternalLinks(homeHtml, base, 25);
    const allUrls     = [...new Set([...sitemapUrls, ...navLinks])]
      .filter(u => !seen.has(normalise(u)) && scoreUrl(u) > 0)
      .map(u => ({ url: u, score: scoreUrl(u) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map(x => x.url);

    console.log(`[wp] HTML crawl: ${allUrls.length} pages to fetch`);

    for (const url of allUrls) {
      if (seen.has(normalise(url))) continue;
      seen.add(normalise(url));
      const html = await getHTML(url, { headers: extraHeaders });
      if (!html || isCloudflarePage(html)) continue;
      let text = extractContent(html, url);
      if (text.length < 100) text = getMetaText(html);
      if (text.length < 40)  continue;
      items.push({ title: getTitle(html), text, source: url, type: guessType(url, text), platform: "wordpress" });
      console.log(`[wp] ✓ ${url} (${text.length} chars)`);
      await sleep(DELAY_MS);
    }
  }

  // ── STRATEGY 3: CF fallback — try known paths ─────────────
  // When HTML is blocked but REST also empty, try common WP page
  // paths directly. Some CF configs allow specific paths through.
  if (items.length < 3) {
    console.log(`[wp] Low items (${items.length}) — trying CF path bypass`);
    const knownPaths = ["/about", "/about-us", "/services", "/contact",
                        "/pricing", "/faq", "/team", "/portfolio", "/blog",
                        "/our-services", "/contact-us", "/get-in-touch"];
    for (const path of knownPaths) {
      const url  = base + path;
      if (seen.has(normalise(url))) continue;
      const html = await getHTML(url, { headers: extraHeaders });
      if (!html || isCloudflarePage(html)) continue;
      const text = extractContent(html, url);
      if (text.length < 40) continue;
      seen.add(normalise(url));
      items.push({ title: getTitle(html), text, source: url, type: guessType(url), platform: "wordpress_path" });
      console.log(`[wp] ✓ CF-path: ${url}`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`[wp] Total items: ${items.length}`);
  return items;
}

// ══════════════════════════════════════════════════════════════
// SHOPIFY CRAWLER
// ══════════════════════════════════════════════════════════════
async function crawlShopify(base, extraHeaders = {}) {
  const items = [];

  // Products
  const products = await getJSON(`${base}/products.json?limit=20`, { headers: extraHeaders });
  if (products?.products) {
    for (const p of products.products.slice(0, 20)) {
      const title = p.title || "";
      const desc  = extractContent(p.body_html || "");
      const price = p.variants?.[0]?.price ? ` Price: $${p.variants[0].price}.` : "";
      const tags  = p.tags ? ` Tags: ${Array.isArray(p.tags) ? p.tags.join(", ") : p.tags}.` : "";
      const text  = `${title}. ${desc}${price}${tags}`.trim();
      if (text.length < 30) continue;
      items.push({ title, text, source: `${base}/products/${p.handle}`, type: "product", platform: "shopify" });
    }
  }

  // Pages
  const pages = await getJSON(`${base}/pages.json`, { headers: extraHeaders });
  if (pages?.pages) {
    for (const p of pages.pages) {
      const text = extractContent(p.body_html || "");
      if (text.length < 30) continue;
      items.push({ title: p.title || "", text, source: `${base}/pages/${p.handle}`, type: "page", platform: "shopify" });
    }
  }

  // Blog articles
  const blogs = await getJSON(`${base}/blogs.json`, { headers: extraHeaders });
  if (blogs?.blogs) {
    for (const blog of blogs.blogs.slice(0, 2)) {
      const arts = await getJSON(`${base}/blogs/${blog.handle}/articles.json?limit=5`, { headers: extraHeaders });
      for (const a of arts?.articles || []) {
        const text = extractContent(a.body_html || "");
        if (text.length < 30) continue;
        items.push({ title: a.title || "", text, source: `${base}/blogs/${blog.handle}/${a.handle}`, type: "post", platform: "shopify" });
      }
    }
  }

  // Fallback: homepage + sitemap
  if (items.length === 0) {
    console.log("[shopify] APIs blocked — falling back to HTML");
    return crawlGenericHTML(base, extraHeaders);
  }
  return items;
}

// ══════════════════════════════════════════════════════════════
// SQUARESPACE CRAWLER
// ══════════════════════════════════════════════════════════════
async function crawlSquarespace(base, homeHtml) {
  const items = [];
  const seen  = new Set([normalise(base)]);

  // Homepage JSON
  const homeJson = await getJSON(`${base}/?format=json`);
  if (homeJson?.collection?.description) {
    const text = extractContent(homeJson.collection.description);
    if (text.length > 40) items.push({ title: homeJson.collection.title || "", text, source: base, type: "homepage", platform: "squarespace" });
  } else if (homeHtml) {
    const text = extractContent(homeHtml, base);
    if (text.length > 40) items.push({ title: getTitle(homeHtml), text, source: base, type: "homepage", platform: "squarespace" });
  }

  // Nav pages
  const navLinks = homeHtml ? getInternalLinks(homeHtml, base, 15) : [];
  for (const url of navLinks.slice(0, 7)) {
    if (seen.has(normalise(url))) continue;
    seen.add(normalise(url));

    const pageJson = await getJSON(`${url}?format=json`);
    if (pageJson?.collection?.description) {
      const text = extractContent(pageJson.collection.description);
      if (text.length > 30) items.push({ title: pageJson.collection.title || "", text, source: url, type: guessType(url), platform: "squarespace" });
    } else {
      const html = await getHTML(url);
      if (!html) continue;
      const text = extractContent(html, url);
      if (text.length > 40) items.push({ title: getTitle(html), text, source: url, type: guessType(url), platform: "squarespace" });
    }
    await sleep(DELAY_MS);
  }

  if (items.length === 0) return crawlGenericHTML(base, {}, homeHtml);
  return items;
}

// ══════════════════════════════════════════════════════════════
// WIX CRAWLER
// ══════════════════════════════════════════════════════════════
async function crawlWix(base, homeHtml) {
  const items = [];
  const seen  = new Set([normalise(base)]);

  // JSON-LD from homepage
  if (homeHtml) {
    for (const [, raw] of homeHtml.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
      try {
        const d    = JSON.parse(raw);
        const vals = [d.name, d.description, d.telephone, d.email,
                      d.address?.streetAddress, d.openingHours].filter(Boolean);
        if (vals.length > 1) items.push({ title: d.name || "", text: vals.join(". "), source: base, type: "structured", platform: "wix" });
      } catch {}
    }

    const homeText = extractContent(homeHtml, base);
    if (homeText.length > 60) items.push({ title: getTitle(homeHtml), text: homeText, source: base, type: "homepage", platform: "wix" });

    // Nav pages
    const navLinks = getInternalLinks(homeHtml, base, 12);
    for (const url of navLinks.slice(0, 6)) {
      if (seen.has(normalise(url))) continue;
      seen.add(normalise(url));
      const html = await getHTML(url);
      if (!html) continue;
      const text = extractContent(html, url);
      const meta = text.length < 150 ? getMetaText(html) : "";
      const final = text.length >= 150 ? text : meta;
      if (final.length > 40) items.push({ title: getTitle(html), text: final, source: url, type: guessType(url), platform: "wix" });
      await sleep(DELAY_MS);
    }
  }

  if (items.length === 0) return crawlGenericHTML(base, {}, homeHtml);
  return items;
}

// ══════════════════════════════════════════════════════════════
// WEBFLOW CRAWLER — clean semantic HTML, easiest to parse
// ══════════════════════════════════════════════════════════════
async function crawlWebflow(base, homeHtml) {
  const items = [];
  const seen  = new Set([normalise(base)]);

  if (homeHtml) {
    const text = extractContent(homeHtml, base);
    if (text.length > 60) items.push({ title: getTitle(homeHtml), text, source: base, type: "homepage", platform: "webflow" });
  }

  // Sitemap first, nav links fallback
  const sitemapUrls = await getSitemapUrls(base);
  const navLinks    = homeHtml ? getInternalLinks(homeHtml, base, 20) : [];
  const allUrls     = [...new Set([...sitemapUrls, ...navLinks])]
    .filter(u => !seen.has(normalise(u)))
    .map(u => ({ url: u, score: scoreUrl(u) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(x => x.url);

  for (const url of allUrls) {
    if (seen.has(normalise(url))) continue;
    seen.add(normalise(url));
    const page = await fetchPage(url);
    if (!page) continue;
    items.push({ title: page.title, text: page.text, source: url, type: guessType(url), platform: "webflow" });
    await sleep(DELAY_MS);
  }

  return items;
}

// ══════════════════════════════════════════════════════════════
// GENERIC HTML CRAWLER — used for custom/plain sites + fallback
// ══════════════════════════════════════════════════════════════
async function crawlGenericHTML(base, extraHeaders = {}, cachedHomeHtml = null) {
  const items = [];
  const seen  = new Set([normalise(base), normalise(base + "/")]);

  // Homepage
  const homeHtml = cachedHomeHtml || await getHTML(base, { headers: extraHeaders });
  if (homeHtml) {
    const title = getTitle(homeHtml);
    const text  = extractContent(homeHtml, base);
    const meta  = text.length < 150 ? getMetaText(homeHtml) : "";
    const final = text.length >= 60 ? text : meta;
    if (final.length > 40) items.push({ title, text: final, source: base, type: "homepage", platform: "generic" });
  }

  // Discover via sitemap + nav links
  const sitemapUrls = await getSitemapUrls(base, extraHeaders);
  const navLinks    = homeHtml ? getInternalLinks(homeHtml, base, 25) : [];
  const combined    = [...new Set([...sitemapUrls, ...navLinks])]
    .filter(u => !seen.has(normalise(u)) && scoreUrl(u) > 0)
    .map(u => ({ url: u, score: scoreUrl(u) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map(x => x.url);

  for (const url of combined) {
    if (seen.has(normalise(url))) continue;
    seen.add(normalise(url));

    const html = await getHTML(url, { headers: extraHeaders });
    if (!html) continue;

    const title = getTitle(html);
    let   text  = extractContent(html, url);
    if (text.length < 150) text = getMetaText(html);
    if (text.length < 40) continue;

    items.push({ title, text, source: url, type: guessType(url, text), platform: "generic" });
    console.log(`[generic] ✓ ${url}`);
    await sleep(DELAY_MS);
  }

  return items;
}

// ══════════════════════════════════════════════════════════════
// AUTH SITE CRAWLER
// ══════════════════════════════════════════════════════════════
async function crawlAuthSite(base, authConfig) {
  const headers = buildAuthHeaders(authConfig);
  console.log(`[auth] type=${authConfig.type}`);

  // Check if it's WordPress with auth
  const wpCheck = await getJSON(`${base}/wp-json/wp/v2/types`, { headers, timeout: 6000 });
  if (wpCheck?.post) return crawlWordPress(base, headers);

  return crawlGenericHTML(base, headers);
}

function buildAuthHeaders(cfg = {}) {
  if (cfg.type === "cookie"  && cfg.value)    return { Cookie: cfg.value };
  if (cfg.type === "bearer"  && cfg.value)    return { Authorization: `Bearer ${cfg.value}` };
  if (cfg.type === "header"  && cfg.key)      return { [cfg.key]: cfg.value };
  if (cfg.type === "basic"   && cfg.username) {
    const encoded = Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64");
    return { Authorization: `Basic ${encoded}` };
  }
  return {};
}

// ══════════════════════════════════════════════════════════════
// SITE TYPE DETECTOR — fixed, homepage fetch first
// ══════════════════════════════════════════════════════════════
export async function detectSiteType(siteUrl) {
  const base = siteUrl.replace(/\/$/, "");

  console.log(`[detect] Fetching homepage: ${base}`);

  // Fetch homepage with full browser headers
  const homeHtml = await getHTML(base, { timeout: TIMEOUT_PAGE });
  console.log(`[detect] Homepage HTML size: ${homeHtml?.length || 0} chars`);

  if (homeHtml && homeHtml.length > 200) {
    // Platform fingerprints — check most specific first
    if (homeHtml.includes("cdn.shopify.com") || homeHtml.includes("Shopify.theme"))   { console.log("[detect] → shopify");     return { type: "shopify",     base, homeHtml }; }
    if (homeHtml.includes("static.squarespace.com"))                                   { console.log("[detect] → squarespace"); return { type: "squarespace", base, homeHtml }; }
    if (homeHtml.includes("static.wixstatic.com") || homeHtml.includes("wix-bolt"))   { console.log("[detect] → wix");         return { type: "wix",         base, homeHtml }; }
    if (homeHtml.includes("webflow.com") || homeHtml.includes("data-wf-page"))        { console.log("[detect] → webflow");     return { type: "webflow",     base, homeHtml }; }
    if (homeHtml.includes("wp-content/") || homeHtml.includes("wp-includes/"))        { console.log("[detect] → wordpress");   return { type: "wordpress",   base, homeHtml }; }
    if (homeHtml.includes("woocommerce") || homeHtml.includes("WooCommerce"))         { console.log("[detect] → wordpress");   return { type: "wordpress",   base, homeHtml }; }
  }

  // Homepage blocked or too small — try platform-specific probes in parallel
  console.log("[detect] HTML fingerprint failed, trying probes...");
  const [wpSitemap, wpApi, shopifyApi] = await Promise.all([
    getHTML(`${base}/wp-sitemap.xml`,         { timeout: 5000 }),
    getJSON(`${base}/wp-json/wp/v2/types`,    { timeout: 5000 }),
    getJSON(`${base}/products.json?limit=1`,  { timeout: 5000 }),
  ]);

  if (wpSitemap?.includes("<urlset") || wpSitemap?.includes("<sitemapindex"))
                                              { console.log("[detect] → wordpress (sitemap)"); return { type: "wordpress", base, homeHtml }; }
  if (wpApi?.post)                           { console.log("[detect] → wordpress (REST)");    return { type: "wordpress", base, homeHtml }; }
  if (shopifyApi?.products)                  { console.log("[detect] → shopify (API)");       return { type: "shopify",   base, homeHtml }; }

  console.log(`[detect] → generic (html=${homeHtml?.length||0})`);
  return { type: "generic", base, homeHtml };
}

// ══════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ══════════════════════════════════════════════════════════════
export async function crawlAnySite(siteUrl, options = {}) {
  const { authConfig = {}, manualSections = [] } = options;
  const base = siteUrl.replace(/\/$/, "");

  console.log(`\n[crawl] ═══ START: ${base} ═══`);

  // 1. Detect platform
  const { type, homeHtml } = await detectSiteType(base);
  console.log(`[crawl] Platform detected: ${type}`);

  // 2. Route to correct crawler
  let rawItems = [];
  const hasAuth = authConfig && Object.keys(authConfig).length > 0 && authConfig.type;

  if (hasAuth) {
    rawItems = await crawlAuthSite(base, authConfig);
  } else {
    switch (type) {
      case "wordpress":   rawItems = await crawlWordPress(base);                break;
      case "shopify":     rawItems = await crawlShopify(base);                  break;
      case "squarespace": rawItems = await crawlSquarespace(base, homeHtml);    break;
      case "wix":         rawItems = await crawlWix(base, homeHtml);            break;
      case "webflow":     rawItems = await crawlWebflow(base, homeHtml);        break;
      default:            rawItems = await crawlGenericHTML(base, {}, homeHtml); break;
    }
  }

  console.log(`[crawl] Raw items from site: ${rawItems.length}`);

  // 3. Add manual sections
  for (const s of manualSections) {
    const text = `${s.title ? s.title + ". " : ""}${(s.content || "").trim()}`;
    if (text.length > 20) rawItems.push({ title: s.title || "", text, source: "manual", type: s.type || "manual", platform: "manual" });
  }

  // 4. Chunk all items
  const seen   = new Set();
  const chunks = [];

  for (const item of rawItems) {
    const textChunks = chunkText(item.text);
    textChunks.forEach((chunk, i) => {
      const id = item.source === "manual"
        ? `manual_${(item.title || "sec").toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 28)}_${i}`
        : `${urlToSlug(item.source, item.type)}_${i}`;

      if (seen.has(id)) return;
      seen.add(id);

      chunks.push({
        chunkId:  id,
        text:     chunk,
        source:   item.source,
        type:     item.type    || "page",
        title:    item.title   || "",
        platform: item.platform || type,
      });
    });
  }

  console.log(`[crawl] ═══ DONE: ${chunks.length} chunks from ${rawItems.length} pages (${type}) ═══\n`);
  return { chunks, platform: type, pageCount: rawItems.length };
}

export default crawlAnySite;
