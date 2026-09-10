#!/usr/bin/env node
/**
 * bdhd.ae static build.
 *
 * Reads content/writing/*.md, renders the Writing index and one page per
 * article into the site root, generates a plate and an Open Graph image for
 * each piece, writes writing/feed.xml and refreshes sitemap.xml.
 *
 * Usage: npm run build
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { load as yamlLoad } from 'js-yaml';
import { Resvg } from '@resvg/resvg-js';
import sharp from 'sharp';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONTENT = join(ROOT, 'content', 'writing');
const TEMPLATES = join(ROOT, 'templates');
const OUT = join(ROOT, 'writing');

const SITE = 'https://bdhd.ae';
const WPM = 220;
const AUTHOR = 'Phil Broadhead OBE';
const PALETTE = { ink: '#1A1A2E', lav: '#F5F7FF', b1: '#5271FF', b2: '#768DFF', b3: '#99AAFF', b4: '#BAC6FF' };
const FONTS = [join(ROOT, 'assets', 'fonts', 'PlayfairDisplay.ttf'), join(ROOT, 'assets', 'fonts', 'SourceSans3.ttf')];

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const warnings = [];
const errors = [];

/* ---------- helpers ---------- */

const esc = (s = '') => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const escAttr = esc;

function fill(tpl, vars) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

/** Parse a UTC date-only string without timezone drift. */
function parseDate(v) {
  if (v instanceof Date) return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
  const [y, m, d] = String(v).trim().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
const monthYear = (d) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const longDate = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const isoDate = (d) => d.toISOString().slice(0, 10);
const rfc822 = (d) => d.toUTCString();

/* ---------- deterministic plates ---------- */

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Build a deterministic abstract plate for an article. Five motifs in the
 * brand palette, chosen and parameterised by seed. Square viewBox, sliced by
 * the CSS, so the same markup serves every aspect ratio on the site.
 */
function plateSvg(seedValue, uid) {
  const rnd = mulberry32(seedValue);
  const pick = Math.floor(rnd() * 3);
  const r = (min, max) => min + rnd() * (max - min);
  const ri = (min, max) => Math.round(r(min, max));
  const P = PALETTE;
  const open = `<svg viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg" role="presentation">`;

  if (pick === 0) {
    const y1 = ri(190, 225), y2 = ri(105, 135);
    return `${open}<defs><linearGradient id="ga${uid}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${P.b1}"/><stop offset="1" stop-color="${P.b4}"/></linearGradient>`
      + `<pattern id="gp${uid}" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M40 0H0V40" fill="none" stroke="#fff" stroke-opacity=".18"/></pattern></defs>`
      + `<rect width="400" height="400" fill="url(#ga${uid})"/><rect width="400" height="400" fill="url(#gp${uid})"/>`
      + `<g fill="#fff" fill-opacity=".92"><rect x="60" y="${y1}" width="140" height="70" rx="3"/>`
      + `<rect x="210" y="${y1}" width="140" height="70" rx="3" fill-opacity=".6"/>`
      + `<rect x="135" y="${y2}" width="140" height="70" rx="3" fill-opacity=".75"/></g>`
      + `<path d="M0 ${ri(300, 330)} Q100 290 200 310 T400 300 V400 H0Z" fill="${P.ink}" fill-opacity=".35"/></svg>`;
  }

  if (pick === 1) {
    // Nested frames: concentric rectangles stepping through the four blues.
    const cols = [P.b4, P.b3, P.b2, P.b1];
    const step = ri(34, 46), drift = ri(-14, 14);
    let frames = '';
    for (let i = 0; i < 4; i++) {
      const inset = i * step;
      frames += `<rect x="${inset + 40}" y="${inset + 40 + Math.round(drift * (i / 3))}" `
        + `width="${320 - inset * 2}" height="${320 - inset * 2}" fill="${cols[i]}"/>`;
    }
    return `${open}<rect width="400" height="400" fill="${P.ink}"/>`
      + `<defs><pattern id="gn${uid}" width="50" height="50" patternUnits="userSpaceOnUse">`
      + `<path d="M50 0H0V50" fill="none" stroke="#fff" stroke-opacity=".1"/></pattern></defs>`
      + `<rect width="400" height="400" fill="url(#gn${uid})"/>${frames}</svg>`;
  }

  // Four-square motif. Scale, gap and origin vary widely, and the block is
  // allowed to bleed off the canvas, so two plates rarely read the same.
  const base = [P.b1, P.b2, P.b3, P.b4];
  const turn = Math.floor(rnd() * 4);
  const cols = base.slice(turn).concat(base.slice(0, turn));
  const size = ri(95, 205), gap = ri(4, 26);
  const span = size * 2 + gap;
  const ox = ri(-Math.round(span * 0.22), 400 - span + Math.round(span * 0.22));
  const oy = ri(-Math.round(span * 0.22), 400 - span + Math.round(span * 0.22));
  let squares = '';
  for (let i = 0; i < 4; i++) {
    const cx = ox + (i % 2) * (size + gap);
    const cy = oy + Math.floor(i / 2) * (size + gap);
    squares += `<rect x="${cx}" y="${cy}" width="${size}" height="${size}" fill="${cols[i]}"/>`;
  }
  return `${open}<rect width="400" height="400" fill="${P.ink}"/>`
    + `<defs><pattern id="gq${uid}" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#fff" stroke-opacity=".1"/></pattern></defs>`
    + `<rect width="400" height="400" fill="url(#gq${uid})"/>${squares}</svg>`;
}

/* ---------- Open Graph image ---------- */

/** Greedy wrap using an approximate Playfair advance width. */
function wrapText(text, fontSize, maxWidth) {
  const avg = fontSize * 0.48;
  const max = Math.max(8, Math.floor(maxWidth / avg));
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > max && line) { lines.push(line); line = w; } else { line = next; }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * The right-hand band of the OG card, as markup that nests inside a 400x400
 * viewBox. A photo is inlined as a data URI because the rasteriser has no
 * network and no notion of the site root.
 */
function ogPlateInner(a) {
  if (hasUsableImage(a)) {
    const rel = a.image;
    const buf = readFileSync(imageSource(a));
    // Sniff the magic bytes: a file downloaded as .jpg is not always a JPEG,
    // and mislabelling it here silently breaks the rasteriser.
    const mime = buf[0] === 0x89 && buf[1] === 0x50 ? 'image/png'
      : buf[0] === 0xFF && buf[1] === 0xD8 ? 'image/jpeg'
        : /\.png$/i.test(rel) ? 'image/png' : 'image/jpeg';
    return `<image href="data:${mime};base64,${buf.toString('base64')}" x="0" y="0" `
      + `width="400" height="400" preserveAspectRatio="xMidYMid slice"/>`;
  }
  const seed = a.plateSeed !== null && Number.isFinite(a.plateSeed)
    ? a.plateSeed : hashString(a.slug);
  return plateSvg(seed, a.slug.replace(/[^a-z0-9]/gi, ''))
    .replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
}

function ogSvg(title, plateInner) {
  const W = 1200, H = 630, split = Math.round(W * 0.55);
  const pad = 64, avail = split - pad * 2;
  let size = 58, lines = wrapText(title, size, avail);
  for (const s of [58, 52, 46, 41, 36]) {
    size = s; lines = wrapText(title, s, avail);
    if (lines.length <= 5) break;
  }
  const lh = size * 1.12;
  const blockH = lines.length * lh;
  let y = Math.max(pad + size, (H - 70 - blockH) / 2 + size);
  const tspans = lines
    .map((l, i) => `<tspan x="${pad}" y="${Math.round(y + i * lh)}">${esc(l)}</tspan>`).join('');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`
    + `<rect width="${W}" height="${H}" fill="${PALETTE.ink}"/>`
    + `<svg x="${split}" y="0" width="${W - split}" height="${H}" viewBox="0 0 400 400" preserveAspectRatio="xMidYMid slice">${plateInner}</svg>`
    + `<rect x="${split - 1}" y="0" width="3" height="${H}" fill="${PALETTE.b1}"/>`
    + `<text font-family="Playfair Display" font-size="${size}" fill="#FFFFFF">${tspans}</text>`
    + `<g font-family="Source Sans 3" font-size="21" fill="${PALETTE.b4}">`
    + `<text x="${pad}" y="${H - 52}">${esc(AUTHOR)}</text>`
    + `<text x="${pad}" y="${H - 24}" fill="#8E9BD6">bdhd.ae</text></g>`
    + `</svg>`;
}

function renderOg(svg, outPath) {
  const r = new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Source Sans 3' },
    fitTo: { mode: 'width', value: 1200 },
  });
  writeFileSync(outPath, r.render().asPng());
}

/* ---------- content ---------- */

/**
 * Literal reader for the flat front matter schema: "key: value" lines plus
 * "key: |" block scalars. Used only when the YAML parser rejects the block.
 */
function parseFlatFrontMatter(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2];

    if (value.trim() === '|' || value.trim() === '>') {
      const block = [];
      while (i + 1 < lines.length && (/^\s+/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        block.push(lines[++i].replace(/^\s{2}/, ''));
      }
      out[key] = block.join('\n').trim();
      continue;
    }

    value = value.replace(/\s+#\s.*$/, '').trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length > 1)
      || (value.startsWith("'") && value.endsWith("'") && value.length > 1)) {
      value = value.slice(1, -1);
    }
    if (value === 'true') out[key] = true;
    else if (value === 'false') out[key] = false;
    else if (value === '' || value === 'null' || value === '~') out[key] = '';
    else if (/^-?\d+$/.test(value)) out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

function readArticles() {
  const files = readdirSync(CONTENT).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const out = [];
  for (const file of files) {
    const slug = file.replace(/\.md$/, '');
    const raw = readFileSync(join(CONTENT, file), 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) { errors.push(`${file}: no front matter block`); continue; }

    let fm;
    try {
      fm = yamlLoad(m[1]) || {};
    } catch (e) {
      // Front matter here is a flat set of key/value pairs plus one block
      // scalar, so an unquoted colon in a title or pull quote is a very easy
      // mistake to make. Fall back to a literal reader rather than refusing to
      // build, and tell the author how to silence it.
      fm = parseFlatFrontMatter(m[1]);
      warnings.push(`${file}: front matter is not strictly valid YAML (${e.message.split('\n')[0]}). `
        + `Read literally instead - quote any value containing a colon.`);
    }

    const body = m[2].trim();
    if (fm.draft === true) continue;

    for (const key of ['title', 'standfirst', 'date']) {
      if (!fm[key]) errors.push(`${file}: missing required front matter "${key}"`);
    }

    // House style: single hyphens only, no bullet lists.
    const bad = [...body.matchAll(/[—–]/g)];
    if (bad.length) {
      const ctx = body.slice(Math.max(0, bad[0].index - 40), bad[0].index + 40).replace(/\s+/g, ' ');
      errors.push(`${file}: ${bad.length} em/en dash(es) in body. First near: "...${ctx}..."`);
    }
    if (/^\s*[-*+]\s+\S/m.test(body)) {
      warnings.push(`${file}: body appears to contain a bullet list (not used in article bodies)`);
    }

    const words = body.split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.round(words / WPM));
    const date = parseDate(fm.date);

    out.push({
      slug, file, body, words, minutes, date,
      title: String(fm.title).trim(),
      standfirst: String(fm.standfirst).trim(),
      topics: (fm.topics || '').toString().trim(),
      publishedBy: (fm.published_by || '').toString().trim(),
      publishedUrl: (fm.published_url || '').toString().trim(),
      image: (fm.image || '').toString().trim(),
      imageCredit: (fm.image_credit || '').toString().trim(),
      plateSeed: fm.plate_seed === undefined || fm.plate_seed === null || fm.plate_seed === ''
        ? null : Number(fm.plate_seed),
      pullquote: (fm.pullquote || '').toString().trim(),
      facts: (fm.facts || '').toString().trim(),
      url: `${SITE}/writing/${slug}/`,
      path: `/writing/${slug}/`,
      // Where a piece appeared first is its canonical home; the copy here is
      // the syndicated one. Pieces that started on this site are their own.
      canonical: (fm.published_url || '').toString().trim() || `${SITE}/writing/${slug}/`,
    });
  }
  out.sort((a, b) => b.date - a.date);
  return out;
}

/** Render body markdown, inserting the pull quote after the third paragraph. */
function renderBody(a) {
  const tokens = marked.lexer(a.body);
  let paras = 0, inserted = false, html = '';
  for (const t of tokens) {
    html += marked.parser([t]);
    if (t.type === 'paragraph') {
      paras++;
      if (paras === 3 && a.pullquote && !inserted) {
        html += `<blockquote><p>${esc(a.pullquote)}</p></blockquote>\n`;
        inserted = true;
      }
    }
  }
  if (a.pullquote && !inserted) {
    html += `<blockquote><p>${esc(a.pullquote)}</p></blockquote>\n`;
  }
  return html.replace(/<h2>Sources<\/h2>/i, '<h2 id="sources">Sources</h2>');
}

/* Widths emitted for every source photo. Rows never render wider than 280
 * CSS px, so 440 covers them at 2x; the hero and article header cap around
 * 600, so 1200 covers those. */
const IMG_WIDTHS = { small: 440, large: 1000 };
const IMG_QUALITY = 72;

/** Source file on disk for an article's `image:` output path. */
function imageSource(a) {
  if (!a.image) return null;
  const base = a.image.split('/').pop();
  return join(CONTENT, 'img', base);
}

/** Derived output path, e.g. /writing/img/slug-440.webp */
function imageVariant(a, key, ext = 'jpg') {
  const base = a.image.split('/').pop().replace(/\.[^.]+$/, '');
  return key === 'large'
    ? `/writing/img/${base}.${ext}`
    : `/writing/img/${base}-${IMG_WIDTHS[key]}.${ext}`;
}

/** True when front matter names a photo and its source is actually on disk. */
function hasUsableImage(a) {
  if (!a.image) return false;
  const src = imageSource(a);
  if (src && existsSync(src)) return true;
  if (!a.imageMissingWarned) {
    warnings.push(`${a.file}: image "${a.image}" has no source at `
      + `content/writing/img/${a.image.split('/').pop()}. `
      + `Falling back to a generated plate - drop the file in and rebuild.`);
    a.imageMissingWarned = true;
  }
  return false;
}

/** Resize each source photo into the widths the pages actually use. */
async function buildImages(articles) {
  const dir = join(OUT, 'img');
  mkdirSync(dir, { recursive: true });
  let written = 0, bytes = 0;
  for (const a of articles) {
    if (!hasUsableImage(a)) continue;
    const src = imageSource(a);
    for (const key of Object.keys(IMG_WIDTHS)) {
      const buf = await sharp(src).rotate()
        .resize({ width: IMG_WIDTHS[key], withoutEnlargement: true })
        .jpeg({ quality: IMG_QUALITY, mozjpeg: true })
        .toBuffer();
      writeFileSync(join(ROOT, imageVariant(a, key).replace(/^\//, '')), buf);
      written++; bytes += buf.length;
    }
  }
  return { written, bytes };
}

function plateFor(a, { lazy = true, priority = false, size = 'large', sizes = '' } = {}) {
  if (hasUsableImage(a)) {
    // The hero and the article header are above the fold and are the LCP
    // element on their page, so they load eagerly and at high priority.
    // Where the rendered width varies a lot between phone and desktop, offer
    // both widths so a phone never downloads the 1200.
    const srcset = sizes
      ? ` srcset="${escAttr(imageVariant(a, 'small'))} ${IMG_WIDTHS.small}w, `
        + `${escAttr(imageVariant(a, 'large'))} ${IMG_WIDTHS.large}w" sizes="${escAttr(sizes)}"`
      : '';
    return `<img src="${escAttr(imageVariant(a, size))}" alt=""${srcset}`
      + `${lazy ? ' loading="lazy"' : ''}${priority ? ' fetchpriority="high"' : ''}`
      + ` decoding="async">`;
  }
  const seed = a.plateSeed !== null && Number.isFinite(a.plateSeed)
    ? a.plateSeed : hashString(a.slug);
  return plateSvg(seed, a.slug.replace(/[^a-z0-9]/gi, ''));
}

/**
 * Header image for an article page. A real photo carries its credit
 * underneath; a generated plate is purely decorative and is hidden from
 * assistive technology.
 */
function artFigure(a) {
  const isPhoto = hasUsableImage(a);
  const credit = isPhoto && a.imageCredit
    ? `\n    <figcaption class="credit">${esc(a.imageCredit)}</figcaption>` : '';
  if (!credit) {
    return `  <div class="art-figure"><div class="plate" aria-hidden="true">${plateFor(a, { lazy: false, priority: true, sizes: '(max-width: 900px) 92vw, 380px' })}</div></div>`;
  }
  return `  <figure class="art-figure">
    <div class="plate">${plateFor(a, { lazy: false, priority: true, sizes: '(max-width: 900px) 92vw, 380px' })}</div>${credit}
  </figure>`;
}

/* ---------- chrome ---------- */

const header = (here) => `<header class="top">
  <a class="mark" href="/"><span class="sq" aria-hidden="true"><i></i><i></i><i></i><i></i></span><b>BDHD</b><span>GROUP</span></a>
  <nav aria-label="Primary"><a href="/#about"${here === 'about' ? ' class="here"' : ''}>About</a><a href="/phil-broadhead"${here === 'phil' ? ' class="here"' : ''}>Phil Broadhead OBE</a><a href="/writing/"${here === 'writing' ? ' class="here"' : ''}>Writing</a><a href="/#contact"${here === 'contact' ? ' class="here"' : ''}>Contact</a></nav>
</header>`;

const footer = () => `<footer class="site-foot"><span>BDHD Group. Dubai, UAE. &copy; ${new Date().getUTCFullYear()}</span><span><a href="mailto:phil@bdhd.ae">phil@bdhd.ae</a></span></footer>`;

/* ---------- pages ---------- */

function buildIndex(articles, css, tpl) {
  const [hero, ...rest] = articles;

  const rows = rest.map((a) => {
    const meta = [`<span>${esc(monthYear(a.date))}</span>`];
    if (a.publishedBy) meta.push(`<span>First published by ${esc(a.publishedBy)}</span>`);
    meta.push(`<span>${a.minutes} min</span>`);
    return `    <article class="row">
      <a class="plate" href="${a.path}" aria-hidden="true" tabindex="-1">${plateFor(a, { size: 'small' })}</a>
      <div>
        <h3><a href="${a.path}">${esc(a.title)}</a></h3>
        <p>${esc(a.standfirst)}</p>
        <div class="meta">${meta.join('')}</div>
      </div>
    </article>`;
  }).join('\n');

  const publishers = [...new Set(articles.map((a) => a.publishedBy).filter(Boolean))];
  const strip = publishers.length
    ? `<div class="strip"><div class="in">
    <h4>Also published by</h4>
    ${publishers.map((p) => `<span class="pub">${esc(p)}</span>`).join('\n    ')}
  </div></div>`
    : '';

  return fill(tpl, {
    TITLE: 'Writing | BDHD Group',
    DESC: 'Essays and columns on the Gulf economy, government, and where policy meets private capital, by Phil Broadhead OBE.',
    OG_TITLE: 'Writing | BDHD Group',
    CANONICAL: `${SITE}/writing/`,
    OG_IMAGE: `${SITE}/writing/${hero.slug}/og.png`,
    CSS: css,
    HEADER: header('writing'),
    FOOTER: footer(),
    HERO_MONTH: monthYear(hero.date),
    HERO_URL: hero.path,
    HERO_TITLE: esc(hero.title),
    HERO_STAND: esc(hero.standfirst),
    HERO_READ: `${hero.minutes} min read`,
    HERO_TOPICS: esc(hero.topics),
    HERO_PLATE: plateFor(hero, { lazy: false, priority: true, sizes: '(max-width: 900px) 92vw, 46vw' }),
    ROWS: rows,
    STRIP: strip,
  });
}

function buildArticle(a, all, css, tpl) {
  const others = all.filter((x) => x.slug !== a.slug).slice(0, 2);
  const more = others.length ? `  <div class="more">
    <h2>More writing</h2>
${others.map((o) => `    <a href="${o.path}">${esc(o.title)}<small>${esc(monthYear(o.date))}${o.publishedBy ? `, first published by ${esc(o.publishedBy)}` : ''}</small></a>`).join('\n')}
  </div>` : '';

  const hasSources = /<h2 id="sources">/.test(a.renderedBody);
  const aside = a.facts ? `  <aside class="aside" aria-label="The facts behind this piece">
    <b>The facts behind this piece</b>
    ${esc(a.facts)}${hasSources ? ' <a href="#sources">Sources</a>' : ''}
  </aside>` : '';

  const firstPub = a.publishedBy
    ? `<span class="first-pub">First published by ${a.publishedUrl
      ? `<a href="${escAttr(a.publishedUrl)}" target="_blank" rel="noopener noreferrer">${esc(a.publishedBy)}</a>`
      : esc(a.publishedBy)}</span>`
    : '';

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: a.title,
    description: a.standfirst,
    datePublished: isoDate(a.date),
    author: { '@type': 'Person', name: AUTHOR, url: `${SITE}/phil-broadhead` },
    publisher: { '@type': 'Organization', name: 'BDHD Group', url: SITE },
    image: `${SITE}${a.path}og.png`,
    mainEntityOfPage: { '@type': 'WebPage', '@id': a.url },
    ...(a.topics ? { keywords: a.topics } : {}),
  }, null, 2);

  const shareText = encodeURIComponent(a.title);
  const shareUrl = encodeURIComponent(a.url);

  return fill(tpl, {
    TITLE: `${esc(a.title)} | BDHD Group`,
    DESC: esc(a.standfirst),
    OG_TITLE: esc(a.title),
    CANONICAL: a.canonical,
    PAGE_URL: a.url,
    OG_IMAGE: `${SITE}${a.path}og.png`,
    PUBLISHED_TIME: isoDate(a.date),
    JSONLD: jsonld,
    CSS: css,
    HEADER: header('writing'),
    FOOTER: footer(),
    ART_TITLE: esc(a.title),
    ART_STAND: esc(a.standfirst),
    ART_DATE_LONG: longDate(a.date),
    ART_READ: `${a.minutes} min read`,
    ART_TOPICS: esc(a.topics),
    ART_FIGURE: artFigure(a),
    ART_BODY: a.renderedBody,
    FIRST_PUB: firstPub,
    ASIDE: aside,
    MORE: more,
    SHARE_X: `https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}`,
    SHARE_LI: `https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}`,
  });
}

function buildFeed(articles) {
  const items = articles.map((a) => `    <item>
      <title>${esc(a.title)}</title>
      <link>${a.url}</link>
      <guid isPermaLink="true">${a.url}</guid>
      <pubDate>${rfc822(a.date)}</pubDate>
      <description>${esc(a.standfirst)}</description>
      <content:encoded><![CDATA[${a.renderedBody}]]></content:encoded>
    </item>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Writing - BDHD Group</title>
    <link>${SITE}/writing/</link>
    <atom:link href="${SITE}/writing/feed.xml" rel="self" type="application/rss+xml"/>
    <description>Essays and columns on the Gulf economy, government, and where policy meets private capital, by ${AUTHOR}.</description>
    <language>en-GB</language>
    <lastBuildDate>${rfc822(articles[0].date)}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

/**
 * Rewrite the "Latest writing" block on the homepage, between its markers.
 * Everything else on that page is hand-written and left alone.
 */
function buildHomepageBlock(articles) {
  const file = join(ROOT, 'index.html');
  const START = '<!-- LATEST_WRITING:START -->';
  const END = '<!-- LATEST_WRITING:END -->';
  const html = readFileSync(file, 'utf8');
  const i = html.indexOf(START), j = html.indexOf(END);
  if (i === -1 || j === -1) {
    warnings.push('index.html: LATEST_WRITING markers not found, homepage block not updated');
    return false;
  }
  const a = articles[0];
  const block = `${START}
    <section class="section">
        <div class="container">
            <h2 class="section__heading">Latest writing</h2>
            <p class="latest__meta">${esc(monthYear(a.date))}${a.publishedBy ? ` &middot; First published by ${esc(a.publishedBy)}` : ''} &middot; ${a.minutes} min read</p>
            <p class="latest__title"><a href="${a.path}">${esc(a.title)}</a></p>
            <div class="prose">
                <p>${esc(a.standfirst)}</p>
            </div>
            <p class="profile-link"><a href="/writing/">Read this and everything else</a></p>
        </div>
    </section>
    `;
  writeFileSync(file, html.slice(0, i) + block + html.slice(j));
  return true;
}

function buildSitemap(articles) {
  // Pinned to the newest article rather than the clock, so a rebuild that
  // changes nothing produces no diff.
  const latest = isoDate(articles[0].date);
  const urls = [
    { loc: `${SITE}/`, lastmod: latest, priority: '1.0' },
    { loc: `${SITE}/phil-broadhead`, lastmod: '2026-08-06', priority: '0.8' },
    { loc: `${SITE}/writing/`, lastmod: latest, priority: '0.8' },
    ...articles.map((a) => ({ loc: a.url, lastmod: isoDate(a.date), priority: '0.7' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

/* ---------- main ---------- */

async function main() {
  const css = readFileSync(join(TEMPLATES, 'writing.css'), 'utf8');
  const indexTpl = readFileSync(join(TEMPLATES, 'index.html'), 'utf8');
  const articleTpl = readFileSync(join(TEMPLATES, 'article.html'), 'utf8');

  const articles = readArticles();

  if (errors.length) {
    console.error('\nBuild failed:\n' + errors.map((e) => `  - ${e}`).join('\n') + '\n');
    process.exit(1);
  }
  if (!articles.length) {
    console.error('Build failed: no publishable articles in content/writing/');
    process.exit(1);
  }

  for (const a of articles) a.renderedBody = renderBody(a);

  mkdirSync(OUT, { recursive: true });
  const img = await buildImages(articles);

  for (const a of articles) {
    const dir = join(OUT, a.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.html'), buildArticle(a, articles, css, articleTpl));
    renderOg(ogSvg(a.title, ogPlateInner(a)), join(dir, 'og.png'));
  }

  writeFileSync(join(OUT, 'index.html'), buildIndex(articles, css, indexTpl));
  writeFileSync(join(OUT, 'feed.xml'), buildFeed(articles));
  writeFileSync(join(ROOT, 'sitemap.xml'), buildSitemap(articles));
  const homeOk = buildHomepageBlock(articles);

  for (const w of warnings) console.warn(`  warning: ${w}`);

  console.log(`Built ${articles.length} articles`);
  console.log(`  writing/index.html`);
  for (const a of articles) console.log(`  writing/${a.slug}/ (${a.words} words, ${a.minutes} min)`);
  console.log(`  writing/img/ (${img.written} files, ${Math.round(img.bytes / 1024)}K total)`);
  console.log(`  writing/feed.xml`);
  console.log(`  sitemap.xml (${articles.length + 3} urls)`);
  if (homeOk) console.log(`  index.html (Latest writing block)`);
}

await main();
