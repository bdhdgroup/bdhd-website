#!/usr/bin/env node
/**
 * One-page speaker sheet PDF for the speaking kit.
 *
 * Reads content/speaking/index.md, lays it out on A4 and prints it with
 * headless Chrome to content/speaking/kit/speaker-sheet.pdf. Kept out of the
 * main build so that `npm run build` never depends on Chrome being present.
 *
 * Usage: npm run speaker-sheet   (then npm run build to publish it in the kit)
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { load as yamlLoad } from 'js-yaml';
import sharp from 'sharp';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'content', 'speaking');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const raw = readFileSync(join(SRC, 'index.md'), 'utf8');
const page = yamlLoad(raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);

async function dataUri(path, w, h) {
  const buf = await sharp(path).rotate().resize({ width: w, height: h, fit: 'cover', position: sharp.strategy.attention })
    .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}
const font = (f) => `data:font/woff2;base64,${readFileSync(join(ROOT, 'assets', 'fonts', f)).toString('base64')}`;

const headshot = await dataUri(join(SRC, 'kit', (page.kit_headshots?.[0]?.file) || 'headshot-formal.jpg'), 420, 420);
const sheetPhotos = (page.sheet_photos || ['keynote-stage.jpg', 'on-air-bbc-studio.jpg'])
  .filter((f) => existsSync(join(SRC, 'media', f)));
const photos = await Promise.all(sheetPhotos.map((f) => dataUri(join(SRC, 'media', f), 600, 400)));

const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>
@font-face{font-family:"Playfair Display";font-weight:400 600;src:url(${font('playfair.woff2')}) format("woff2")}
@font-face{font-family:"Source Sans 3";font-weight:300 600;src:url(${font('sourcesans.woff2')}) format("woff2")}
@page{size:A4;margin:0}
*{box-sizing:border-box}
body{margin:0;font-family:"Source Sans 3",sans-serif;color:#1A1A2E;font-size:10.5pt;line-height:1.45;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.sheet{width:210mm;height:297mm;display:flex;flex-direction:column}
.head{background:#1A1A2E;color:#fff;padding:14mm 14mm 11mm;display:grid;grid-template-columns:1fr 38mm;gap:9mm;align-items:center}
.mark{display:flex;align-items:center;gap:7px;font-size:8.5pt;letter-spacing:.14em;color:#BAC6FF;margin-bottom:6mm}
.sq{display:grid;grid-template-columns:1fr 1fr;gap:1.5px;width:15px;height:15px}.sq i{background:#5271FF}.sq i:nth-child(2){background:#768DFF}.sq i:nth-child(3){background:#99AAFF}.sq i:nth-child(4){background:#BAC6FF}
.mark b{color:#fff;font-weight:600}
h1{font-family:"Playfair Display",serif;font-weight:500;font-size:25pt;line-height:1.08;margin:0 0 3mm}
.role{font-family:"Playfair Display",serif;font-size:12.5pt;line-height:1.35;color:#D6DAF0;margin:0}
.headshot{width:38mm;height:38mm;border-radius:50%;object-fit:cover;border:2px solid #5271FF}
.proof{display:grid;grid-template-columns:repeat(4,1fr);gap:4mm;padding:5mm 14mm;background:#F5F7FF;border-bottom:1px solid #DDE1F0}
.proof div{font-family:"Playfair Display",serif;font-size:10.5pt;line-height:1.25;border-left:2.5px solid #5271FF;padding-left:3mm}
.body{padding:7mm 14mm 0;display:grid;grid-template-columns:1.2fr 1fr;gap:9mm;flex:1}
h2{font-family:"Playfair Display",serif;font-weight:500;font-size:13pt;margin:0 0 2.5mm;padding-bottom:1.5mm;border-bottom:1px solid #DDE1F0}
p{margin:0 0 3mm}
.topics,.formats{margin:0 0 5mm;padding:0;list-style:none}
.topics li{margin:0 0 3mm}.formats li{margin:0 0 1.6mm}
.topics b,.formats b{font-weight:600}
.topics span,.formats span{color:#3A3A52}
.photos{display:grid;grid-template-columns:1fr 1fr;gap:3mm;margin-top:4mm}
.photos img{width:100%;aspect-ratio:3/2;object-fit:cover;border-radius:2px;display:block}
.foot{margin-top:auto;background:#1A1A2E;color:#fff;padding:6mm 14mm;display:flex;justify-content:space-between;align-items:center;font-size:10pt}
.foot b{font-family:"Playfair Display",serif;font-weight:500;font-size:12pt}
.foot span{color:#BAC6FF}
</style></head><body><div class="sheet">
<div class="head"><div>
<div class="mark"><span class="sq"><i></i><i></i><i></i><i></i></span><b>BDHD</b> GROUP</div>
<h1>Phil Broadhead OBE</h1>
<p class="role">${esc(page.headline)}</p>
</div><img class="headshot" src="${headshot}" alt=""></div>
<div class="proof">${(page.proof || []).map((p) => `<div>${esc(p)}</div>`).join('')}</div>
<div class="body">
<div><h2>Biography</h2>${esc(page.long_bio).split(/(?<=\.)\s+(?=An experienced)/).map((p) => `<p>${p}</p>`).join('')}
<h2>Formats</h2><ul class="formats">${(page.formats || []).map((f) => `<li><b>${esc(f.title)}.</b> <span>${esc(f.text)}</span></li>`).join('')}</ul></div>
<div><h2>Topics</h2><ul class="topics">${(page.topics || []).map((t) => `<li><b>${esc(t.title)}.</b> <span>${esc(t.text)}</span></li>`).join('')}</ul>
<div class="photos">${photos.slice(0, 2).map((p) => `<img src="${p}" alt="">`).join('')}</div></div>
</div>
<div class="foot"><div><b>Invite Phil to speak</b><br><span>bdhd.ae/speaking</span></div><div style="text-align:right">${esc(page.invite_email || 'phil@bdhd.ae')}<br><span>Dubai, UAE</span></div></div>
</div></body></html>`;

const dir = mkdtempSync(join(tmpdir(), 'speaker-sheet-'));
const htmlPath = join(dir, 'sheet.html');
writeFileSync(htmlPath, html);
const out = join(SRC, 'kit', 'speaker-sheet.pdf');
execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', '--virtual-time-budget=5000',
  `--print-to-pdf=${out}`, `file://${htmlPath}`], { stdio: 'ignore' });
console.log(`Wrote ${out.replace(ROOT + '/', '')} (${Math.round(readFileSync(out).length / 1024)}K)`);
