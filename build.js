/**
 * Blog Builder — Markdown notes → beautiful static blog
 *
 * Usage: node build.js
 *   Reads notes from ../n/ → generates ./posts/ + ./index.html
 */

const fs = require('fs');
const path = require('path');

// ─── Configuration ──────────────────────────────────────────────
const NOTES_DIR = 'F:/notes/my-personal-notes/n';
const OUTPUT_DIR = __dirname;
const POSTS_DIR = path.join(OUTPUT_DIR, 'posts');
const SITE_TITLE = '📒 笔记博客';
const SITE_DESC = '信息安全';
const CATEGORIES = {
    '基本':     { name: '电脑技巧',   emoji: '🖥️', slug: 'basic' },
    '数据结构': { name: '数据结构',   emoji: '📊', slug: 'ds' },
    'web基础':  { name: 'Web 基础',   emoji: '🌐', slug: 'web' },
    'pikachu':  { name: 'Pikachu靶场',emoji: '🎯', slug: 'pikachu' },
    'ctfshow web': { name: 'CTF 刷题',emoji: '🚩', slug: 'ctfshow' },
};
const SKIP_FILES = ['README.md', 'sync_notes.bat'];

// ─── Utility ────────────────────────────────────────────────────
function esc(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function slugify(name) {
    return name.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9一-鿿\-_]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'untitled';
}
function excerpt(text, len) {
    return text.replace(/\s+/g, ' ').trim().slice(0, len) + (text.length > len ? '…' : '');
}
function getCategory(filePath) {
    const rel = path.relative(NOTES_DIR, filePath);
    for (const [key, val] of Object.entries(CATEGORIES)) {
        if (rel.startsWith(key + path.sep) || rel.startsWith(key + '/')) return val;
    }
    return { name: '其他', emoji: '📄', slug: 'other' };
}
function ensureDir(dir) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Markdown → HTML (robust) ────────────────────────────────
function mdToHTML(md) {
    md = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // ── Step 1: Extract footnote definitions ──
    const footnotes = {};
    md = md.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (m, key, val) => {
        footnotes[key] = val.trim();
        return '';
    });

    // ── Step 2: Extract fenced code blocks (line scanner — robust) ──
    const codeBlocks = [];
    const rawLines = md.split('\n');
    const outLines = [];
    let inFence = false, fenceLang = '', fenceBuf = [];
    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        const fenceMatch = line.match(/^[ \t]*`{3,}(\S*)/);
        if (fenceMatch) {
            if (!inFence) {
                inFence = true;
                fenceLang = fenceMatch[1] || '';
                fenceBuf = [];
            } else {
                const idx = codeBlocks.length;
                codeBlocks.push({ lang: fenceLang, code: fenceBuf.join('\n') });
                outLines.push(`<!--CODEBLOCK_${idx}-->`);
                inFence = false;
                fenceLang = '';
                fenceBuf = [];
            }
            continue;
        }
        if (inFence) { fenceBuf.push(line); continue; }
        outLines.push(line);
    }
    // Unclosed fence → treat as paragraph
    if (inFence) {
        outLines.push('```' + fenceLang);
        outLines.push(...fenceBuf);
    }
    md = outLines.join('\n');

    // ── Step 3: Protect inline code ──
    const inlineCodes = [];
    md = md.replace(/`([^`]+)`/g, (m, code) => {
        const idx = inlineCodes.length;
        inlineCodes.push(code);
        return `\x00ICODE${idx}\x00`;
    });

    // ── Step 4: Process into blocks ──
    const lines = md.split('\n');
    const blocks = [];  // { type, content/items/header/rows/children }
    let buf = [];
    let inBlockquote = false;
    let bqBuf = [];

    function flush() {
        if (inBlockquote) {
            // End blockquote
            if (bqBuf.length) {
                blocks.push({ type: 'blockquote', content: processInline(bqBuf.join('\n')) });
                bqBuf = [];
            }
            inBlockquote = false;
        }
        const text = buf.join('\n').trim();
        buf = [];
        if (!text) return;
        blocks.push({ type: 'paragraph', content: text });
    }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        // Code block placeholder
        if (/<!--CODEBLOCK_\d+-->/.test(trimmed)) {
            flush();
            blocks.push({ type: 'code_placeholder', content: trimmed });
            continue;
        }

        // HR
        if (/^-{3,}\s*$/.test(trimmed) && !trimmed.includes('<!--')) {
            flush();
            blocks.push({ type: 'hr' });
            continue;
        }

        // Table
        if (trimmed.includes('|') && i + 1 < lines.length && /^\|?[\s\-:|]+\|?$/.test(lines[i+1].trim())) {
            flush();
            const header = trimmed.split('|').filter(c => c.trim()).map(c => c.trim());
            const alignLine = lines[i+1].trim();
            const aligns = alignLine.split('|').filter(c => c.trim()).map(c => {
                const t = c.trim();
                if (t.startsWith(':') && t.endsWith(':')) return 'center';
                if (t.endsWith(':')) return 'right';
                return 'left';
            });
            const rows = [];
            i += 2;
            while (i < lines.length && lines[i].trim().includes('|')) {
                rows.push(lines[i].trim().split('|').filter(c => c.trim()).map(c => c.trim()));
                i++;
            }
            i--;
            blocks.push({ type: 'table', header, aligns, rows });
            continue;
        }

        // Blockquote
        if (/^>\s?/.test(line)) {
            if (!inBlockquote) {
                flush(); // flush any pending paragraph
                inBlockquote = true;
            }
            bqBuf.push(line.replace(/^>\s?/, ''));
            continue;
        } else if (inBlockquote) {
            flush(); // exits blockquote
        }

        // Blank line → flush paragraph
        if (trimmed === '') {
            flush();
            blocks.push({ type: 'blank' });
            continue;
        }

        // Accumulate
        buf.push(line);
    }
    flush(); // final flush

    // ── Step 5: Merge & classify paragraph blocks ──
    const merged = [];
    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type === 'blank') continue;

        if (b.type === 'paragraph') {
            const text = b.content;
            const hMatch = text.match(/^(#{1,6})\s+(.+)$/m);
            if (hMatch && text.split('\n').length === 1) {
                merged.push({ type: 'heading', level: hMatch[1].length, content: processInline(hMatch[2]) });
                continue;
            }
            const isOL = /^\d+\.\s/m.test(text);
            const isUL = /^[\*\-\+]\s/m.test(text);
            if (isOL || isUL) {
                const listType = isOL ? 'ol' : 'ul';
                const itemRegex = isOL ? /^\d+\.\s/ : /^[\*\-\+]\s/;
                const items = splitListItems(text, itemRegex).map(processInline);
                // Merge with previous list block of same type
                const last = merged[merged.length - 1];
                if (last && last.type === listType) {
                    last.items.push(...items);
                } else {
                    merged.push({ type: listType, items });
                }
                continue;
            }
            merged.push({ type: 'p', content: processInline(text) });
            continue;
        }

        merged.push(b);
    }

    // ── Step 6: Render to HTML ──
    let html = '';
    for (const b of merged) {
        switch (b.type) {
            case 'heading': html += `<h${b.level}>${b.content}</h${b.level}>\n`; break;
            case 'p':       html += `<p>${b.content}</p>\n`; break;
            case 'hr':      html += `<hr>\n`; break;
            case 'blockquote': html += `<blockquote>${b.content}</blockquote>\n`; break;
            case 'ul':      html += `<ul>\n${b.items.map(i => `<li>${i}</li>`).join('\n')}\n</ul>\n`; break;
            case 'ol':      html += `<ol>\n${b.items.map(i => `<li>${i}</li>`).join('\n')}\n</ol>\n`; break;
            case 'table':
                html += '<table>\n<thead><tr>\n';
                html += b.header.map((h, j) => `<th style="text-align:${b.aligns[j] || 'left'}">${processInline(h)}</th>`).join('\n');
                html += '\n</tr></thead>\n<tbody>\n';
                html += b.rows.map(r => '<tr>\n' + r.map((c, j) =>
                    `<td style="text-align:${b.aligns[j] || 'left'}">${processInline(c)}</td>`).join('\n') + '\n</tr>').join('\n');
                html += '\n</tbody>\n</table>\n';
                break;
            case 'code_placeholder':
                html += b.content + '\n';
                break;
        }
    }

    // ── Step 7: Restore code blocks ──
    html = html.replace(/<!--CODEBLOCK_(\d+)-->/g, (m, idx) => {
        const cb = codeBlocks[parseInt(idx)];
        const lang = cb.lang ? ` class="language-${esc(cb.lang)}"` : '';
        return `<pre><code${lang}>${esc(cb.code)}</code></pre>`;
    });

    // ── Step 8: Restore inline codes ──
    html = html.replace(/\x00ICODE(\d+)\x00/g, (m, idx) => {
        return `<code>${esc(inlineCodes[parseInt(idx)])}</code>`;
    });

    // ── Step 9: Footnotes ──
    if (Object.keys(footnotes).length) {
        html += '<div class="footnotes"><hr><ol>\n';
        for (const [key, val] of Object.entries(footnotes)) {
            html += `<li id="fn-${key}">${val} <a href="#fnref-${key}">↩</a></li>\n`;
        }
        html += '</ol></div>\n';
    }

    return html;
}

// Split list text into items, handling multi-line items
function splitListItems(text, regex) {
    const items = [];
    const lines = text.split('\n');
    let current = null;
    for (const line of lines) {
        const stripped = line.replace(/^\s+/, '');
        if (regex.test(stripped)) {
            if (current !== null) items.push(current.trim());
            current = stripped.replace(regex, '');
        } else if (current !== null && line.trim()) {
            current += '\n' + line;
        }
    }
    if (current !== null) items.push(current.trim());
    return items;
}

// Process inline formatting (bold, italic, images, links, etc.)
function processInline(text) {
    if (!text) return '';
    text = String(text);

    // Protect HTML <img> tags — parse src and decide
    const htmlImgs = [];
    text = text.replace(/<img\s+[^>]+>/gi, (m) => {
        const idx = htmlImgs.length;
        const srcMatch = m.match(/src\s*=\s*"([^"]+)"/i) || m.match(/src\s*=\s*'([^']+)'/i);
        const altMatch = m.match(/alt\s*=\s*"([^"]*)"/i);
        let src = srcMatch ? srcMatch[1] : '';
        let alt = altMatch ? altMatch[1] : '';
        // Decide if broken
        let isBroken = false;
        if (!src || /^https?:\/\//.test(src)) {
            isBroken = false; // external URL, keep (or empty)
            if (!src) isBroken = true;
        } else if (/^[A-Za-z]:[\\/]/.test(src) || /typora-user-images/.test(src)) {
            isBroken = true; // local absolute path
        }
        // also check if it's a raw filename that was already fixed
        if (!isBroken && !/^https?:\/\//.test(src) && !/^[A-Za-z]:/.test(src)) {
            isBroken = false; // relative path, should be fine
        }
        htmlImgs.push({ src, alt, isBroken });
        return `\x00HTMLIMG${idx}\x00`;
    });

    // Images ![alt](src)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, src) => {
        alt = alt || '';
        const isBroken = /^[A-Za-z]:\\/.test(src) || /typora-user-images/.test(src);
        if (isBroken) return `<span class="missing-img">📷 [${esc(alt) || '图片'}]</span>`;
        return `<img src="${esc(src)}" alt="${esc(alt)}" loading="lazy">`;
    });

    // Links [text](url)
    text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (m, txt, url) => {
        txt = txt || url;
        if (/^https?:\/\//.test(url)) {
            return `<a href="${esc(url)}" target="_blank" rel="noopener">${processInline(txt)}</a>`;
        }
        return `<a href="posts/${slugify(txt)}.html">${processInline(txt)}</a>`;
    });

    // Bold **text**
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic *text*
    text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
    // Highlight ==text==
    text = text.replace(/==(.+?)==/g, '<mark>$1</mark>');
    // Strikethrough ~~text~~
    text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');

    // Superscript: ^text^  (match anything except space/newline until closing ^)
    text = text.replace(/\^([^\s^][^^]*?)\^/g, '<sup>$1</sup>');
    // Subscript: ~text~
    text = text.replace(/~([^\s~][^~]*?)~/g, '<sub>$1</sub>');

    // Footnote references [^key]
    text = text.replace(/\[\^([^\]]+)\]/g, (m, key) =>
        `<sup class="footnote-ref"><a href="#fn-${key}" id="fnref-${key}">[${key}]</a></sup>`);

    // Task lists
    text = text.replace(/\[x\]/gi, '<input type="checkbox" checked disabled>');
    text = text.replace(/\[ \]/g, '<input type="checkbox" disabled>');

    // Restore HTML img tags
    text = text.replace(/\x00HTMLIMG(\d+)\x00/g, (m, idx) => {
        const ii = htmlImgs[parseInt(idx)];
        if (!ii || !ii.src) return '<span class="missing-img">📷 [图片]</span>';
        if (ii.isBroken) return `<span class="missing-img">📷 [${esc(ii.alt || '图片')}]</span>`;
        if (/^https?:\/\//.test(ii.src)) return `<img src="${esc(ii.src)}" alt="${esc(ii.alt)}" loading="lazy">`;
        return `<img src="${esc(ii.src)}" alt="${esc(ii.alt)}" loading="lazy">`;
    });

    return text;
}

// ─── HTML Templates ─────────────────────────────────────────────
function pageTemplate(title, body, depth) {
    const prefix = depth === 0 ? '.' : '../'.repeat(depth);
    const cssPath = prefix + 'css/style.css';
    const homePath = prefix + 'index.html';
    const navLinks = Object.values(CATEGORIES).map(c =>
        `<li><a href="${homePath}#cat-${c.slug}">${c.emoji} ${c.name}</a></li>`
    ).join('\n      ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} — ${SITE_TITLE}</title>
<link rel="stylesheet" href="${cssPath}">
</head>
<body>
<nav class="nav">
  <div class="container">
    <a href="${homePath}" class="nav-brand"><span class="icon">N</span> 笔记博客</a>
    <ul class="nav-links">
      <li><a href="${homePath}">首页</a></li>
      ${navLinks}
    </ul>
  </div>
</nav>
<main class="container">
  <div class="post-page">
    <a href="${homePath}" class="back-link">← 返回首页</a>
    ${body}
  </div>
</main>
<div class="ocean-waves"></div>
<footer class="footer">
  <div class="container">
    <p>📒 鸭蛋的学习笔记 · Powered by plain HTML & CSS</p>
  </div>
</footer>
</body>
</html>`;
}

function indexTemplate(body, postCount, catCount) {
    const catBtns = Object.values(CATEGORIES).map(c =>
        `<button class="cat-btn" data-cat="${c.slug}">${c.emoji} ${c.name}</button>`
    ).join('\n    ');
    const navLinks = Object.values(CATEGORIES).map(c =>
        `<li><a href="#cat-${c.slug}">${c.emoji} ${c.name}</a></li>`
    ).join('\n      ');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${SITE_TITLE}</title>
<meta name="description" content="${SITE_DESC}">
<link rel="stylesheet" href="css/style.css">
</head>
<body>
<nav class="nav">
  <div class="container">
    <a href="index.html" class="nav-brand"><span class="icon">N</span> 笔记博客</a>
    <ul class="nav-links">
      <li><a href="index.html" class="active">首页</a></li>
      ${navLinks}
    </ul>
  </div>
</nav>
<main class="container">
  <section class="hero">
    <h1>📒 鸭蛋的笔记博客</h1>
    <p>${SITE_DESC}</p>
    <div class="hero-stats">
      <div class="stat"><span class="stat-num">${postCount}</span><span class="stat-label">篇笔记</span></div>
      <div class="stat"><span class="stat-num">${catCount}</span><span class="stat-label">个分类</span></div>
    </div>
  </section>

  <div class="search-wrap">
    <span class="search-icon">🔍</span>
    <input type="text" class="search-input" id="searchBox" placeholder="搜索笔记..." autocomplete="off">
  </div>

  <div class="categories">
    <button class="cat-btn active" data-cat="all">全部</button>
    ${catBtns}
  </div>

  <div id="postContainer">
    ${body}
  </div>

  <div class="empty-state" id="noResults" style="display:none;">
    <div class="icon">🔍</div>
    <p>没有找到匹配的笔记</p>
  </div>
</main>
<div class="ocean-waves"></div>
<footer class="footer">
  <div class="container">
    <p>📒 鸭蛋的学习笔记 · 最后更新 ${new Date().toLocaleDateString('zh-CN')}</p>
  </div>
</footer>
<script>
var searchBox=document.getElementById('searchBox'),cards=document.querySelectorAll('.post-card'),
sections=document.querySelectorAll('[id^="cat-"]'),noResults=document.getElementById('noResults');
searchBox.addEventListener('input',function(){var q=this.value.toLowerCase(),found=!1;cards.forEach(function(c){
var m=!q||c.textContent.toLowerCase().includes(q);c.style.display=m?'':'none';if(m)found=!0});
sections.forEach(function(s){s.style.display=Array.from(s.querySelectorAll('.post-card'))
.some(function(c){return c.style.display!=='none'})?'':'none'});
noResults.style.display=found||!q?'none':''});
var btns=document.querySelectorAll('.cat-btn');btns.forEach(function(b){b.addEventListener('click',function(){
btns.forEach(function(x){x.classList.remove('active')});this.classList.add('active');
var cat=this.dataset.cat;sections.forEach(function(s){s.style.display=(cat==='all'||s.id==='cat-'+cat)?'':'none'});
searchBox.value='';cards.forEach(function(c){c.style.display=''});noResults.style.display='none'})});
</script>
</body>
</html>`;
}

// ─── Build ──────────────────────────────────────────────────────
const allPosts = [];

function buildPost(mdPath) {
    const fname = path.basename(mdPath);
    let raw = fs.readFileSync(mdPath, 'utf-8');

    if (SKIP_FILES.includes(fname)) { console.log(`  ⏭️  SKIP: ${fname}`); return; }

    // Title from filename or frontmatter
    let displayTitle = fname.replace(/\.md$/, '');
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (fmMatch) {
        raw = raw.slice(fmMatch[0].length);
        const tm = fmMatch[1].match(/^title:\s*(.+)$/m);
        if (tm) displayTitle = tm[1].trim().replace(/["']/g, '');
    }

    const slug = slugify(displayTitle);
    const cat = getCategory(mdPath);
    const contentHTML = mdToHTML(raw);
    const plain = raw.replace(/```[\s\S]*?```/g, '').replace(/[#*\[\]`>|]/g, '');

    const body = `
    <article>
      <header class="post-header">
        <span class="post-cat">${cat.emoji} ${cat.name}</span>
        <h1>${esc(displayTitle)}</h1>
        <div class="post-meta">
          <span>📁 ${cat.name}</span>
          <span>📄 ${raw.split('\n').filter(l => l.trim()).length} 行</span>
        </div>
      </header>
      <div class="post-content">
        ${contentHTML}
      </div>
    </article>`;

    const postHTML = pageTemplate(displayTitle, body, 2);
    const catDir = path.join(POSTS_DIR, cat.slug);
    ensureDir(catDir);
    fs.writeFileSync(path.join(catDir, slug + '.html'), postHTML, 'utf-8');

    allPosts.push({ title: displayTitle, slug, cat, fname, excerpt: excerpt(plain, 120), path: `posts/${cat.slug}/${slug}.html` });
    console.log(`  ✅ ${cat.emoji} ${displayTitle}`);
}

function buildIndex() {
    const grouped = {};
    for (const p of allPosts) {
        if (!grouped[p.cat.slug]) grouped[p.cat.slug] = { cat: p.cat, posts: [] };
        grouped[p.cat.slug].posts.push(p);
    }

    let cardsHTML = '';
    for (const [slug, group] of Object.entries(grouped)) {
        cardsHTML += `<section id="cat-${slug}">`;
        cardsHTML += `<h2 style="font-size:1.4rem;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:8px">${group.cat.emoji} ${group.cat.name}<span style="font-size:.8rem;color:var(--text-lighter);font-weight:400">${group.posts.length} 篇</span></h2>`;
        cardsHTML += `<div class="post-grid">`;
        for (const p of group.posts) {
            cardsHTML += `
            <a href="${p.path}" class="post-card">
                <span class="card-cat">${p.cat.emoji} ${p.cat.name}</span>
                <h3>${esc(p.title)}</h3>
                <p>${esc(p.excerpt)}</p>
                <div class="card-meta">📄 ${p.fname}</div>
            </a>`;
        }
        cardsHTML += `</div></section>`;
    }

    fs.writeFileSync(path.join(OUTPUT_DIR, 'index.html'),
        indexTemplate(cardsHTML, allPosts.length, Object.keys(grouped).length), 'utf-8');
    console.log(`\n  🏠 index.html (${allPosts.length} posts)`);
}

// ─── Main ───────────────────────────────────────────────────────
function walk(dir, cb) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.assets')) walk(full, cb);
        else if (e.isFile() && e.name.endsWith('.md')) cb(full);
    }
}

// Copy .assets directories to post directories (flat, same dir as HTML)
function copyAssets() {
    const catMap = {};
    for (const [key, val] of Object.entries(CATEGORIES)) catMap[key] = val.slug;

    function walkAssets(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && e.name.endsWith('.assets')) {
                // Find which category this belongs to
                const relDir = path.relative(NOTES_DIR, path.dirname(full));
                for (const [catKey, catSlug] of Object.entries(catMap)) {
                    if (relDir === catKey || relDir.startsWith(catKey + path.sep) || relDir.startsWith(catKey + '/')) {
                        // Copy to posts/<slug>/<assetName> (flat, sibling of HTML files)
                        const dstDir = path.join(POSTS_DIR, catSlug, e.name);
                        copyDir(full, dstDir);
                        break;
                    }
                }
            } else if (e.isDirectory() && !e.name.startsWith('.')) {
                walkAssets(full);
            }
        }
    }

    function copyDir(src, dst) {
        if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
        for (const e of fs.readdirSync(src, { withFileTypes: true })) {
            const s = path.join(src, e.name);
            const d = path.join(dst, e.name);
            if (e.isDirectory()) { copyDir(s, d); }
            else { fs.copyFileSync(s, d); }
        }
    }

    walkAssets(NOTES_DIR);
    const assetCount = countFiles(NOTES_DIR, /\.assets[\\/]/);
    if (assetCount > 0) console.log(`  📷 Copied ${assetCount} asset files`);
}

function countFiles(dir, filter) {
    let n = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) n += countFiles(path.join(dir, e.name), filter);
            else n++;
        }
    } catch(e) {}
    return n;
}

console.log('🔨 Building blog...\n📝 Generating posts:\n');
if (fs.existsSync(POSTS_DIR)) fs.rmSync(POSTS_DIR, { recursive: true });
ensureDir(POSTS_DIR);
walk(NOTES_DIR, buildPost);
copyAssets();
console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━\n');
buildIndex();
console.log('\n✅ Blog built!');
