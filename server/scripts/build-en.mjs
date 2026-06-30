/**
 * Bake the English landing page from web/index.html.
 *
 * The landing keeps a single source of truth: Russian markup with English in
 * `data-en` attributes (toggled client-side). That's great for users but not
 * for SEO — Google won't rank a `data-en` attribute, and the RU URL is
 * canonical. So for the EU/USA market we generate a real, static English
 * document at web/en/index.html:
 *   - every [data-en] value is baked into the element's innerHTML
 *   - data-en attributes are stripped so the client i18n script can't revert it
 *   - the language toggle becomes plain links (RU → /, EN → /en/)
 *   - head is localised: lang, title, description, canonical, OG/Twitter
 *   - hreflang alternates carry over from the source (already present there)
 *
 * Re-run after editing the landing:  npm run build:en   (from /server)
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'node-html-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '../../web');
const srcPath = resolve(webRoot, 'index.html');
const outDir = resolve(webRoot, 'en');
const outPath = resolve(outDir, 'index.html');

const TITLE_EN = 'MAYA Push — App Store Optimization (ASO) & App Promotion';
const DESC_EN  = 'Push your app to the top of the App Store & Google Play with motivated installs from real devices, any geo. Transparent pricing, no minimum to start.';
const OG_DESC_EN = 'Real devices and local IPs in any geo. Transparent terms and a real-time install table — from strategy to locking your keyword positions in the App Store and Google Play.';
const CANONICAL_EN = 'https://mayapush.com/en/';
const OG_IMAGE_EN = 'https://mayapush.com/og-image-en.png';

const html = readFileSync(srcPath, 'utf8');
const root = parse(html, { comment: true, blockTextElements: { script: true, style: true, pre: true } });

// 1. Bake every translatable element to English, then drop the attribute.
let baked = 0;
for (const el of root.querySelectorAll('[data-en]')) {
  el.set_content(el.getAttribute('data-en'));
  el.removeAttribute('data-en');
  baked++;
}

// 2. <html lang="en">
const htmlEl = root.querySelector('html');
if (htmlEl) htmlEl.setAttribute('lang', 'en');

// 3. Localise the head.
const setAttr = (sel, attr, val) => { const n = root.querySelector(sel); if (n) n.setAttribute(attr, val); };
const setText = (sel, val)       => { const n = root.querySelector(sel); if (n) n.set_content(val); };

setText('title', TITLE_EN);
setAttr('meta[name="description"]', 'content', DESC_EN);
setAttr('link[rel="canonical"]', 'href', CANONICAL_EN);
setAttr('meta[property="og:title"]', 'content', TITLE_EN);
setAttr('meta[property="og:description"]', 'content', OG_DESC_EN);
setAttr('meta[property="og:url"]', 'content', CANONICAL_EN);
setAttr('meta[property="og:locale"]', 'content', 'en_US');
setAttr('meta[property="og:locale:alternate"]', 'content', 'ru_RU');
setAttr('meta[name="twitter:title"]', 'content', TITLE_EN);
setAttr('meta[name="twitter:description"]', 'content', OG_DESC_EN);
setAttr('meta[property="og:image"]', 'content', OG_IMAGE_EN);
setAttr('meta[name="twitter:image"]', 'content', OG_IMAGE_EN);

// 4. Turn the language toggle into real links so the (now no-op) JS toggle
//    can't strand the visitor on the wrong language.
const toggle = root.querySelector('.lang-toggle');
if (toggle) {
  toggle.set_content(
    '<a href="/" class="lt-link">RU</a>' +
    '<a href="/en/" class="lt-link active">EN</a>'
  );
  // The toggle's CSS targets `button`; mirror it for the anchors we just baked.
  const head = root.querySelector('head');
  if (head) head.insertAdjacentHTML('beforeend',
    "\n<style>.lang-toggle .lt-link{background:transparent;color:var(--ink-3);border:0;" +
    "padding:7px 10px;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;" +
    "letter-spacing:0.1em;cursor:pointer;transition:all .15s;text-decoration:none;" +
    "display:inline-flex;align-items:center}.lang-toggle .lt-link:hover{color:var(--ink)}" +
    ".lang-toggle .lt-link.active{background:var(--jade);color:var(--bg)}</style>");
}

let out = root.toString();
if (!/^\s*<!doctype/i.test(out)) out = '<!DOCTYPE html>\n' + out;

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, out, 'utf8');
console.log(`[build:en] baked ${baked} elements → ${outPath} (${(out.length / 1024).toFixed(0)} KB)`);
