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

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
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

function ogSvg(title, plateInner, { line1 = AUTHOR, line2 = 'bdhd.ae' } = {}) {
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
    + `<text x="${pad}" y="${H - 52}">${esc(line1)}</text>`
    + `<text x="${pad}" y="${H - 24}" fill="#8E9BD6">${esc(line2)}</text></g>`
    + `</svg>`;
}

/**
 * Rasterise the card and write it as a JPEG. Share crawlers are happiest with
 * a small, flat JPEG: X in particular silently drops a card whose image it
 * decides is too heavy, and a photographic PNG at 1200x630 easily passes 1MB.
 */
async function renderOg(svg, outPath) {
  const r = new Resvg(svg, {
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Source Sans 3' },
    fitTo: { mode: 'width', value: 1200 },
  });
  const png = r.render().asPng();
  const jpg = await sharp(png).flatten({ background: PALETTE.ink })
    .jpeg({ quality: 84, mozjpeg: true, chromaSubsampling: '4:4:4' }).toBuffer();
  if (outPath) writeFileSync(outPath, jpg);
  return jpg;
}

/** Render an article's card as og-<hash>.jpg and clear out earlier ones. */
async function buildArticleCard(a) {
  const dir = join(OUT, a.slug);
  mkdirSync(dir, { recursive: true });
  const jpg = await renderOg(ogSvg(a.title, ogPlateInner(a)));
  const name = `og-${shortHash(jpg)}.jpg`;
  for (const f of readdirSync(dir)) {
    if (/^og(-[0-9a-f]+)?\.(jpe?g|png)$/i.test(f) && f !== name) unlinkSync(join(dir, f));
  }
  writeFileSync(join(dir, name), jpg);
  a.ogUrl = `${SITE}${a.path}${name}`;
  return jpg.length;
}

/** Card for the homepage: the company lockup with the four-square plate. */
async function buildHomeCard() {
  const dir = join(ROOT, 'assets');
  mkdirSync(dir, { recursive: true });
  const plate = plateSvg(2, 'home').replace(/^<svg[^>]*>/, '').replace(/<\/svg>$/, '');
  const svg = ogSvg('BDHD Group', plate, { line1: 'Advisory | Investment | Governance', line2: 'bdhd.ae' });
  return (await renderOg(svg, join(dir, 'og-home.jpg'))).length;
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

/** Default placement of the pull quote, counted in body paragraphs. */
const PULLQUOTE_AFTER_DEFAULT = 3;

/** pullquote_after: optional positive integer; anything else falls back. */
function parsePullquoteAfter(v, file) {
  if (v === undefined || v === null || v === '') return PULLQUOTE_AFTER_DEFAULT;
  const n = Number(v);
  if (Number.isInteger(n) && n >= 1) return n;
  warnings.push(`${file}: pullquote_after "${v}" is not a whole number of 1 or more. `
    + `Using the default of ${PULLQUOTE_AFTER_DEFAULT}.`);
  return PULLQUOTE_AFTER_DEFAULT;
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
      pullquoteAfter: parsePullquoteAfter(fm.pullquote_after, file),
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
      if (paras === a.pullquoteAfter && a.pullquote && !inserted) {
        html += `<blockquote><p>${esc(a.pullquote)}</p></blockquote>\n`;
        inserted = true;
      }
    }
  }
  if (a.pullquote && !inserted) {
    warnings.push(`${a.file}: pullquote_after is ${a.pullquoteAfter} but the body has only `
      + `${paras} paragraphs. The pull quote has been placed at the end.`);
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

const shortHash = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 8);

/**
 * Content hash of the source photo, memoised per article. It goes into every
 * derived filename so that replacing a photo changes its URL, which is the
 * only reliable way to get browsers, the CDN and share crawlers (X caches a
 * card image for about a week) to fetch the new one.
 */
function imageHash(a) {
  if (!a.imageHash) a.imageHash = shortHash(readFileSync(imageSource(a)));
  return a.imageHash;
}

/** Derived output path, e.g. /writing/img/slug-1af31219-440.jpg */
function imageVariant(a, key, ext = 'jpg') {
  const base = a.image.split('/').pop().replace(/\.[^.]+$/, '');
  const h = imageHash(a);
  return key === 'large'
    ? `/writing/img/${base}-${h}.${ext}`
    : `/writing/img/${base}-${h}-${IMG_WIDTHS[key]}.${ext}`;
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
  const keep = new Set();
  for (const a of articles) {
    if (!hasUsableImage(a)) continue;
    const src = imageSource(a);
    for (const key of Object.keys(IMG_WIDTHS)) {
      const out = imageVariant(a, key).split('/').pop();
      keep.add(out);
      const buf = await sharp(src).rotate()
        .resize({ width: IMG_WIDTHS[key], withoutEnlargement: true })
        .jpeg({ quality: IMG_QUALITY, mozjpeg: true })
        .toBuffer();
      writeFileSync(join(dir, out), buf);
      written++; bytes += buf.length;
    }
  }
  // Old hashes and anything hand-dropped in here are stale: the sources live
  // in content/writing/img and this folder is entirely generated.
  let removed = 0;
  for (const f of readdirSync(dir)) {
    if (/\.(jpe?g|png|webp)$/i.test(f) && !keep.has(f)) { unlinkSync(join(dir, f)); removed++; }
  }
  return { written, bytes, removed };
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
  <nav aria-label="Primary"><a href="/#about"${here === 'about' ? ' class="here"' : ''}>About</a><a href="/phil-broadhead"${here === 'phil' ? ' class="here"' : ''}>Phil Broadhead OBE</a><a href="/writing/"${here === 'writing' ? ' class="here"' : ''}>Writing</a><a href="/speaking/"${here === 'speaking' ? ' class="here"' : ''}>Speaking</a><a href="/#contact"${here === 'contact' ? ' class="here"' : ''}>Contact</a></nav>
</header>`;

const footer = () => `<footer class="site-foot"><span>BDHD Group. Dubai, UAE. &copy; ${new Date().getUTCFullYear()}</span><span><a href="/speaking/#invite">Invite Phil to speak</a> &middot; <a href="mailto:phil@bdhd.ae">phil@bdhd.ae</a></span></footer>`;

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
    OG_IMAGE: hero.ogUrl,
    OG_ALT: esc(hero.title),
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

/**
 * The margin note. Written as one paragraph it renders as one; written as
 * several lines (a list of figures, say) each line keeps its own row rather
 * than collapsing into a run-on block.
 */
function factsHtml(facts) {
  const lines = facts.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return esc(facts);
  return lines.map((l) => `<span class="fact">${esc(l)}</span>`).join('');
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
    ${factsHtml(a.facts)}${hasSources ? ' <a href="#sources">Sources</a>' : ''}
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
    image: a.ogUrl,
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
    OG_IMAGE: a.ogUrl,
    OG_ALT: esc(a.title),
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
    { loc: `${SITE}/speaking/`, lastmod: '2026-10-06', priority: '0.8' },
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

/* ---------- speaking ---------- */

const SPEAK_SRC = join(ROOT, 'content', 'speaking');
const SPEAK_OUT = join(ROOT, 'speaking');
const SPEAK_BG = { large: 1920, small: 960, quality: 68 };
const SPEAK_GRID = { widths: [640, 1000], quality: 76 };
const KIT_ZIP_NAME = 'Phil-Broadhead-OBE-speaker-kit.zip';

/** Read a markdown file's front matter strictly as YAML. */
function readYamlFrontMatter(path) {
  const raw = readFileSync(path, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error(`${path}: no front matter block`);
  return yamlLoad(m[1]) || {};
}

/** Duration of an MP4 from its mvhd box, in ms. Avoids needing ffprobe. */
function mp4DurationMs(buf) {
  const i = buf.indexOf('mvhd');
  if (i < 0) return null;
  const v1 = buf[i + 4] === 1;
  const ts = buf.readUInt32BE(i + (v1 ? 24 : 16));
  const dur = v1 ? Number(buf.readBigUInt64BE(i + 28)) : buf.readUInt32BE(i + 20);
  return ts ? Math.round((dur / ts) * 1000) : null;
}

/**
 * Minimal store-only zip. Photos and PDFs barely compress, and a fixed
 * timestamp keeps the archive byte-identical between builds.
 */
function zipStore(files) {
  const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;
  const parts = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data) >>> 0, size = f.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(size, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(DOS_DATE, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(size, 20);
    ch.writeUInt32LE(size, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + size;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/**
 * Crop a photo to an aspect ratio around its most salient region, write it
 * as WebP at each width under a content-hashed name, and return the URLs
 * plus a focal point (as CSS object-position) for narrower viewports.
 */
async function speakingImage(src, { ratio, widths, quality }, keep) {
  const buf = readFileSync(src);
  const meta = await sharp(buf).rotate().metadata();
  const W = meta.width, H = meta.height;
  let cw = W, ch = Math.round(W / ratio);
  if (ch > H) { ch = H; cw = Math.round(H * ratio); }
  const cropped = await sharp(buf).rotate()
    .resize({ width: cw, height: ch, fit: 'cover', position: sharp.strategy.attention })
    .toBuffer();
  // Second attention pass, square, to find where the subject sits in the crop.
  const sq = Math.min(cw, ch);
  const { info } = await sharp(cropped)
    .resize({ width: sq, height: sq, fit: 'cover', position: sharp.strategy.attention })
    .toBuffer({ resolveWithObject: true });
  const fx = cw > sq ? Math.round(((-(info.cropOffsetLeft || 0) + sq / 2) / cw) * 100) : 50;
  const fy = ch > sq ? Math.round(((-(info.cropOffsetTop || 0) + sq / 2) / ch) * 100) : 50;
  const base = src.split('/').pop().replace(/\.[^.]+$/, '');
  const h = shortHash(Buffer.concat([buf, Buffer.from(`${ratio}|${widths}|${quality}`)]));
  const out = {};
  for (const w of widths) {
    const name = `${base}-${h}-${w}.webp`;
    keep.add(name);
    const file = join(SPEAK_OUT, 'media', name);
    if (!existsSync(file)) {
      writeFileSync(file, await sharp(cropped).resize({ width: w, withoutEnlargement: true })
        .webp({ quality, effort: 5 }).toBuffer());
    }
    out[w] = `/speaking/media/${name}`;
  }
  return { urls: out, focus: `${Math.min(100, Math.max(0, fx))}% ${Math.min(100, Math.max(0, fy))}%` };
}

async function buildSpeaking(baseCss) {
  if (!existsSync(join(SPEAK_SRC, 'index.md'))) return null;
  const page = readYamlFrontMatter(join(SPEAK_SRC, 'index.md'));
  const media = (f) => join(SPEAK_SRC, 'media', f);
  for (const d of ['media', 'kit']) mkdirSync(join(SPEAK_OUT, d), { recursive: true });
  const keep = new Set();

  // Hero montage
  const bg = [];
  for (const [n, f] of (page.background || []).entries()) {
    if (!existsSync(media(f))) { warnings.push(`speaking: background "${f}" not found in content/speaking/media/`); continue; }
    if (/\.(mp4|webm)$/i.test(f)) {
      const buf = readFileSync(media(f));
      const name = `${f.replace(/\.[^.]+$/, '')}-${shortHash(buf)}${f.match(/\.[^.]+$/)[0]}`;
      keep.add(name);
      writeFileSync(join(SPEAK_OUT, 'media', name), buf);
      if (buf.length > 1.5 * 1024 * 1024) warnings.push(`speaking: clip "${f}" is over 1.5MB`);
      bg.push({ type: 'video', src: `/speaking/media/${name}`, dur: mp4DurationMs(buf) || 4000 });
    } else {
      const img = await speakingImage(media(f), { ratio: 16 / 9, widths: [SPEAK_BG.small, SPEAK_BG.large], quality: SPEAK_BG.quality }, keep);
      bg.push({ type: 'img', ...img });
    }
    if (n === 0 && bg[0] && bg[0].type !== 'img') errors.push('speaking: the first background item must be a photo (it is the still shown on phones)');
  }
  const first = bg[0];
  // The automatic focal point follows the brightest detail, which on a stage
  // photo can be the lectern rather than the speaker. hero_focus overrides it
  // for the still that phones see.
  if (first && page.hero_focus) first.focus = page.hero_focus.toString();
  const bgItems = bg.map((b, i) => {
    if (i === 0) {
      return `    <div class="sp-item on" data-loaded="1"><img src="${first.urls[SPEAK_BG.large]}" `
        + `srcset="${first.urls[SPEAK_BG.small]} ${SPEAK_BG.small}w, ${first.urls[SPEAK_BG.large]} ${SPEAK_BG.large}w" sizes="100vw" `
        + `alt="" fetchpriority="high" decoding="async" style="object-position:${first.focus}"></div>`;
    }
    return b.type === 'video'
      ? `    <div class="sp-item" data-type="video" data-src="${b.src}" data-dur="${b.dur}"></div>`
      : `    <div class="sp-item" data-type="img" data-src="${b.urls[SPEAK_BG.large]}"></div>`;
  }).join('\n');

  // On stage grid
  const stagesDir = join(SPEAK_SRC, 'stages');
  const stages = existsSync(stagesDir) ? readdirSync(stagesDir).filter((f) => f.endsWith('.md'))
    .map((f) => ({ file: f, ...readYamlFrontMatter(join(stagesDir, f)) }))
    .sort((a, b) => (Number(a.order) || 999) - (Number(b.order) || 999) || a.file.localeCompare(b.file)) : [];
  const stageHtml = [];
  for (const s of stages) {
    if (!s.photo || !existsSync(media(s.photo))) { warnings.push(`speaking: stages/${s.file} photo "${s.photo}" not found`); continue; }
    const img = await speakingImage(media(s.photo), { ratio: 4 / 3, widths: SPEAK_GRID.widths, quality: SPEAK_GRID.quality }, keep);
    const [w1, w2] = SPEAK_GRID.widths;
    const cap = (s.caption || '').toString().trim();
    const credit = (s.credit || '').toString().trim();
    const alt = (s.alt || `Phil Broadhead OBE${cap ? `, ${cap.toLowerCase()}` : ''}`).toString();
    stageHtml.push(`      <figure><img src="${img.urls[w1]}" srcset="${img.urls[w1]} ${w1}w, ${img.urls[w2]} ${w2}w" `
      + `sizes="(max-width: 640px) 92vw, (max-width: 1100px) 45vw, 400px" width="${w2}" height="${Math.round(w2 * 3 / 4)}" `
      + `alt="${escAttr(alt)}" loading="lazy" decoding="async" style="object-position:${img.focus}">`
      + `${cap || credit ? `<figcaption>${esc(cap)}${credit ? `<small>Photo: ${esc(credit)}</small>` : ''}</figcaption>` : ''}</figure>`);
  }

  // Featured film (optional)
  let featured = '';
  if (page.featured_video && existsSync(media(page.featured_video))) {
    const buf = readFileSync(media(page.featured_video));
    const name = `${page.featured_video.replace(/\.[^.]+$/, '')}-${shortHash(buf)}.mp4`;
    keep.add(name); writeFileSync(join(SPEAK_OUT, 'media', name), buf);
    let poster = '';
    if (page.featured_poster && existsSync(media(page.featured_poster))) {
      const p = await speakingImage(media(page.featured_poster), { ratio: 16 / 9, widths: [1280], quality: 76 }, keep);
      poster = ` poster="${p.urls[1280]}"`;
    }
    featured = `    <div class="sp-film"><video controls preload="none" playsinline${poster} src="/speaking/media/${name}"></video></div>`;
  }

  // Stale media from earlier builds
  for (const f of readdirSync(join(SPEAK_OUT, 'media'))) if (!keep.has(f)) unlinkSync(join(SPEAK_OUT, 'media', f));

  // Speaker kit
  const kitSrc = join(SPEAK_SRC, 'kit');
  const kitFiles = [];
  const kitItems = [];
  const addKit = (name, data, label, note) => {
    kitFiles.push({ name, data });
    writeFileSync(join(SPEAK_OUT, 'kit', name), data);
    kitItems.push(`        <li><a href="/speaking/kit/${name}" download>${esc(label)}</a>${note ? `<small>${esc(note)}</small>` : ''}</li>`);
  };
  const words = (t) => t.split(/\s+/).filter(Boolean).length;
  if (page.short_bio) addKit('Phil-Broadhead-OBE-short-bio.txt', Buffer.from(`${page.short_bio.trim()}\n`), 'Short bio', `${words(page.short_bio)} words, plain text`);
  if (page.long_bio) addKit('Phil-Broadhead-OBE-long-bio.txt', Buffer.from(`${page.long_bio.trim()}\n`), 'Long bio', `${words(page.long_bio)} words, plain text`);
  for (const hs of page.kit_headshots || []) {
    const p = join(kitSrc, hs.file);
    if (!existsSync(p)) { warnings.push(`speaking: headshot "${hs.file}" not found in content/speaking/kit/`); continue; }
    const m = await sharp(p).metadata();
    addKit(`Phil-Broadhead-OBE-${hs.file}`, readFileSync(p), hs.label || 'Headshot', `JPEG, ${m.width} x ${m.height}`);
  }
  if (existsSync(join(kitSrc, 'speaker-sheet.pdf'))) {
    addKit('Phil-Broadhead-OBE-speaker-sheet.pdf', readFileSync(join(kitSrc, 'speaker-sheet.pdf')), 'Speaker sheet', 'One page, PDF');
  } else {
    warnings.push('speaking: no speaker-sheet.pdf in content/speaking/kit/ yet (run npm run speaker-sheet)');
  }
  const zip = zipStore(kitFiles);
  writeFileSync(join(SPEAK_OUT, 'kit', KIT_ZIP_NAME), zip);
  const kitKeep = new Set([...kitFiles.map((f) => f.name), KIT_ZIP_NAME]);
  for (const f of readdirSync(join(SPEAK_OUT, 'kit'))) if (!kitKeep.has(f)) unlinkSync(join(SPEAK_OUT, 'kit', f));

  // Enquiry form
  const email = (page.invite_email || 'phil@bdhd.ae').toString();
  const endpoint = (page.form_endpoint || '').toString().trim();
  const formats = ['Keynote', 'Panel', 'Chair or moderator', 'Fireside conversation', 'Roundtable or private briefing', 'Media'];
  const field = (name, label, { type = 'text', required = false, full = false, auto = '' } = {}) =>
    `        <div${full ? ' class="full"' : ''}><label for="f-${name}">${esc(label)}${required ? '' : ' <span>(optional)</span>'}</label>`
    + (type === 'textarea'
      ? `<textarea id="f-${name}" name="${name}"${required ? ' required' : ''}></textarea>`
      : `<input id="f-${name}" name="${name}" type="${type}"${auto ? ` autocomplete="${auto}"` : ''}${required ? ' required' : ''}>`)
    + `</div>`;
  const form = `      <form id="enquiry" class="sp-form" ${endpoint
    ? `action="${escAttr(endpoint)}" method="post" data-endpoint="1"`
    : `action="mailto:${escAttr(email)}" method="post" enctype="text/plain"`} data-email="${escAttr(email)}">
${endpoint ? '        <input type="hidden" name="_subject" value="Speaking enquiry from bdhd.ae">\n' : ''}${field('name', 'Name', { required: true, auto: 'name' })}
${field('email', 'Email', { type: 'email', required: true, auto: 'email' })}
${field('organisation', 'Organisation', { auto: 'organization' })}
${field('event', 'Event name', { required: true })}
${field('dates', 'Date(s)')}
${field('city', 'City')}
${field('audience', 'Audience (size and who)', { full: true })}
        <div class="full"><label for="f-format">Format <span>(optional)</span></label><select id="f-format" name="format"><option value="">Choose one</option>${formats.map((f) => `<option>${esc(f)}</option>`).join('')}</select></div>
${field('topic', 'Topic or session idea', { full: true })}
${field('message', 'Anything else', { type: 'textarea', full: true })}
        <button type="submit">Send enquiry</button>
        <p class="sp-note" id="enquiry-note" aria-live="polite">${endpoint
    ? `Or email <a href="mailto:${escAttr(email)}">${esc(email)}</a>.`
    : `This opens an email to ${esc(email)} with your details filled in. Or email <a href="mailto:${escAttr(email)}">${esc(email)}</a> directly.`}</p>
      </form>`;

  // Share card
  let ogUrl = `${SITE}/assets/og-home.jpg`;
  if (page.og_photo && existsSync(media(page.og_photo))) {
    const b64 = readFileSync(media(page.og_photo)).toString('base64');
    const inner = `<image href="data:image/jpeg;base64,${b64}" x="0" y="0" width="400" height="400" preserveAspectRatio="xMidYMid slice"/>`;
    const jpg = await renderOg(ogSvg(page.headline || 'Speaking', inner, { line1: AUTHOR, line2: 'bdhd.ae/speaking' }));
    const name = `og-${shortHash(jpg)}.jpg`;
    for (const f of readdirSync(SPEAK_OUT)) if (/^og-[0-9a-f]+\.jpg$/.test(f) && f !== name) unlinkSync(join(SPEAK_OUT, f));
    writeFileSync(join(SPEAK_OUT, name), jpg);
    ogUrl = `${SITE}/speaking/${name}`;
  }

  const jsonld = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: 'Phil Broadhead',
    honorificSuffix: 'OBE',
    url: `${SITE}/speaking/`,
    image: `${SITE}/phil-broadhead.jpg`,
    jobTitle: 'Speaker, chair and moderator',
    worksFor: { '@type': 'Organization', name: 'BDHD Group', url: SITE },
    knowsAbout: (page.topics || []).map((t) => t.title),
    sameAs: ['https://linkedin.com/in/pbroadhead', 'https://x.com/PhilBroadhead', `${SITE}/phil-broadhead`],
  }, null, 2);

  const paras = (t) => (t || '').toString().trim().split(/\n\s*\n/).map((p) => `      <p>${esc(p.replace(/\s+/g, ' '))}</p>`).join('\n');
  const css = baseCss + '\n' + readFileSync(join(TEMPLATES, 'speaking.css'), 'utf8');
  const html = fill(readFileSync(join(TEMPLATES, 'speaking.html'), 'utf8'), {
    TITLE: esc(page.title || 'Speaking - Phil Broadhead OBE'),
    DESC: esc(page.description || page.subhead || ''),
    CANONICAL: `${SITE}/speaking/`,
    OG_TITLE: esc(page.title || 'Speaking - Phil Broadhead OBE'),
    OG_IMAGE: ogUrl,
    OG_ALT: esc(page.headline || ''),
    JSONLD: jsonld,
    CSS: css,
    HEADER: header('speaking'),
    FOOTER: footer(),
    HERO_PRELOAD: first ? first.urls[SPEAK_BG.large] : '',
    HERO_SRCSET: first ? `${first.urls[SPEAK_BG.small]} ${SPEAK_BG.small}w, ${first.urls[SPEAK_BG.large]} ${SPEAK_BG.large}w` : '',
    BG_ITEMS: bgItems,
    EYEBROW: esc(page.eyebrow || 'Speaking'),
    HEADLINE: esc(page.headline || ''),
    SUBHEAD: esc(page.subhead || ''),
    KIT_ZIP: `/speaking/kit/${KIT_ZIP_NAME}`,
    INTRO: paras(page.intro),
    PROOF: (page.proof || []).map((p) => `      <li>${esc(p)}</li>`).join('\n'),
    TOPICS_INTRO: esc(page.topics_intro || ''),
    TOPICS: (page.topics || []).map((t) => `      <article class="sp-topic"><h3>${esc(t.title)}</h3><p>${esc(t.text)}</p></article>`).join('\n'),
    FORMATS: (page.formats || []).map((f) => `      <div><dt>${esc(f.title)}</dt><dd>${esc(f.text)}</dd></div>`).join('\n'),
    STAGE_INTRO: esc(page.stage_intro || ''),
    STAGES: stageHtml.join('\n'),
    ON_AIR: esc(page.on_air || ''),
    FEATURED: featured,
    INVITE_INTRO: esc(page.invite_intro || ''),
    FORM: form,
    KIT_ITEMS: kitItems.join('\n'),
  });
  writeFileSync(join(SPEAK_OUT, 'index.html'), html);

  for (const t of ['—', '–']) {
    if (html.includes(t)) warnings.push('speaking: an em or en dash appears on the page');
  }
  return { bg: bg.length, stages: stageHtml.length, kit: kitFiles.length, updated: page.updated };
}

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

  let cardBytes = 0;
  for (const a of articles) cardBytes += await buildArticleCard(a);
  for (const a of articles) {
    writeFileSync(join(OUT, a.slug, 'index.html'), buildArticle(a, articles, css, articleTpl));
  }

  writeFileSync(join(OUT, 'index.html'), buildIndex(articles, css, indexTpl));
  writeFileSync(join(OUT, 'feed.xml'), buildFeed(articles));
  writeFileSync(join(ROOT, 'sitemap.xml'), buildSitemap(articles));
  const homeOk = buildHomepageBlock(articles);
  const homeCard = await buildHomeCard();
  const speaking = await buildSpeaking(css);

  for (const w of warnings) console.warn(`  warning: ${w}`);

  console.log(`Built ${articles.length} articles`);
  console.log(`  writing/index.html`);
  for (const a of articles) console.log(`  writing/${a.slug}/ (${a.words} words, ${a.minutes} min)`);
  console.log(`  writing/img/ (${img.written} files, ${Math.round(img.bytes / 1024)}K total${img.removed ? `, ${img.removed} stale removed` : ''})`);
  console.log(`  og cards (${articles.length} files, ${Math.round(cardBytes / 1024)}K total)`);
  console.log(`  writing/feed.xml`);
  console.log(`  sitemap.xml (${articles.length + 4} urls)`);
  if (homeOk) console.log(`  index.html (Latest writing block)`);
  console.log(`  assets/og-home.jpg (${Math.round(homeCard / 1024)}K)`);
  if (speaking) console.log(`  speaking/ (${speaking.bg} background items, ${speaking.stages} stage photos, ${speaking.kit} kit files)`);
}

await main();
