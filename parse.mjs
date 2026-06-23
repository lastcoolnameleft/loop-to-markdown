#!/usr/bin/env node
/**
 * Loop HTML → Markdown Parser
 * Reads raw HTML files saved by scrape.mjs and converts them to Markdown.
 * Uses JSDOM to parse the HTML and the same DOM-walking logic as the
 * oztalha/loop-to-markdown userscript.
 *
 * Usage:
 *   node parse.mjs [--src ./loop-backup] [--dest ./loop-md]
 *
 * Can be re-run without re-downloading from Loop.
 */

import { JSDOM } from "jsdom";
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, resolve, relative, dirname, basename, extname } from "path";

// --- Config ---
const args = process.argv.slice(2);
const srcIdx = args.indexOf("--src");
const SRC = resolve(srcIdx !== -1 ? args[srcIdx + 1] : "./loop-backup");
const destIdx = args.indexOf("--dest");
const DEST = resolve(destIdx !== -1 ? args[destIdx + 1] : "./loop-md");

function log(msg) { console.log(msg); }

// --- Markdown conversion (runs on JSDOM document) ---

export function convertHtmlToMarkdown(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;

  const normalize = text => {
    if (!text) return '';
    let result = text.trim().replace(/\s+/g, ' ');
    result = result.replace(/\*\*\*\*/g, '').replace(/\*\*\s*\*\*/g, '');
    result = result.replace(/(\w)\*\*(?=\w)/g, '$1 **');
    result = result.replace(/(\S)\*\*(\w)/g, '$1** $2');
    return result.trim();
  };

  const getMention = el => {
    const avatar = el.querySelector('.fui-Avatar[aria-label]');
    return avatar ? `@${avatar.getAttribute('aria-label')}` : '';
  };

  const getTextContent = (container, skipTables = false) => {
    let text = '';
    const targets = container.querySelectorAll('.scriptor-textRun, [data-testid="resolvedAtMention"]');
    if (targets.length === 0) return getTextContentFallback(container);
    targets.forEach(node => {
      if (skipTables && node.closest('table')) return;
      if (node.dataset.testid === 'resolvedAtMention') {
        text += getMention(node);
      } else if (!node.closest('[data-testid="resolvedAtMention"]')) {
        if (node.classList.contains('scriptor-hyperlink')) {
          const href = (node.getAttribute('title') || '').split('\n')[0];
          if (href) text += `[${node.textContent}](${href})`;
        } else if (node.classList.contains('scriptor-code-editor')) {
          text += '`' + node.textContent + '`';
        } else {
          let content = node.textContent;
          // In JSDOM we can't use getComputedStyle reliably for bold detection,
          // so check for explicit font-weight in style attribute or parent <b>/<strong>
          const isBold = node.closest('b, strong') ||
            (node.getAttribute('style') || '').includes('font-weight') &&
            parseInt((node.getAttribute('style').match(/font-weight:\s*(\d+)/) || [])[1] || 0) >= 600;
          if (isBold && content.trim()) {
            const lead = content.match(/^\s*/)[0], trail = content.match(/\s*$/)[0];
            text += `${lead}**${content.trim()}**${trail}`;
          } else {
            text += content;
          }
        }
      }
    });
    return normalize(text);
  };

  const getTextContentFallback = (container) => {
    let text = '';
    const walk = (node) => {
      if (node.nodeType === 3) { text += node.textContent; return; } // TEXT_NODE
      if (node.nodeType !== 1) return; // ELEMENT_NODE
      const el = node, tag = el.tagName.toLowerCase();
      if (el.dataset?.testid === 'resolvedAtMention') {
        const mention = getMention(el);
        if (mention) { text += mention; return; }
      }
      if (tag === 'a') {
        const href = el.getAttribute('href') || el.getAttribute('title')?.split('\n')[0] || '';
        const linkText = el.textContent.trim();
        if (href && linkText) { text += `[${linkText}](${href})`; return; }
      }
      if (el.classList?.contains('scriptor-code-editor')) { text += '`' + el.textContent + '`'; return; }
      for (const child of el.childNodes) walk(child);
    };
    for (const child of container.childNodes) walk(child);
    return normalize(text);
  };

  const detectCodeLanguage = (code, element) => {
    const langAttr = element?.getAttribute('data-language') ||
      element?.closest('[data-language]')?.getAttribute('data-language') ||
      element?.querySelector('[data-language]')?.getAttribute('data-language');
    if (langAttr) return langAttr.toLowerCase();
    const trimmed = code.trim();
    if (/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|journey)\s/i.test(trimmed)) return 'mermaid';
    if (/^(def |class |import |from |async def |@\w+)/.test(trimmed)) return 'python';
    if (/^(const |let |var |function |import |export |async |=>|interface |type |enum )/.test(trimmed)) return 'javascript';
    if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\s/i.test(trimmed)) return 'sql';
    if (/^\w+:\s*(\n|$)/.test(trimmed) && !trimmed.includes('{') && trimmed.includes(':')) return 'yaml';
    if (/^[\[{]/.test(trimmed) && /[\]}]$/.test(trimmed)) return 'json';
    if (/^(#!\/|npm |yarn |pip |git |docker |kubectl |curl |wget |\$ )/.test(trimmed)) return 'bash';
    return '';
  };

  const parseTable = table => {
    const lines = [], headers = [];
    table.querySelectorAll('[role="columnheader"]').forEach(th => {
      const label = th.querySelector('[aria-label]');
      headers.push(label ? label.getAttribute('aria-label') : getTextContent(th) || '');
    });
    if (headers.length) {
      lines.push('| ' + headers.join(' | ') + ' |', '| ' + headers.map(() => '---').join(' | ') + ' |');
    }
    table.querySelectorAll('tbody tr[data-rowid]').forEach(row => {
      if (row.dataset.rowid === 'HEADER_ROW_ID') return;
      const cells = [...row.querySelectorAll('[role="cell"]')].map(cell => getTextContent(cell).replace(/\|/g, '\\|'));
      if (cells.length) lines.push('| ' + cells.join(' | ') + ' |');
    });
    return lines;
  };

  // Collect image sources
  const imageSources = [];
  document.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src');
    if (src && (src.startsWith('http') || src.startsWith('data:image'))) {
      imageSources.push(src);
    }
  });

  // Convert
  const pages = [...document.querySelectorAll('.scriptor-pageFrame')];
  // If no page frames found, treat the whole body as content
  const containers = pages.length > 0 ? pages.filter(p => !p.closest('table')) : [document.body];
  if (containers.length === 0) return { markdown: '', images: imageSources };

  const lines = [], processed = new Set(), codeTexts = new Set(), codeRawTexts = new Set();

  containers.forEach(container => {
    container.querySelectorAll('.scriptor-paragraph, .scriptor-listItem, .scriptor-component-code-block, [role="table"], [role="heading"]').forEach(el => {
      if (processed.has(el)) return;
      const inTable = el.closest('table');
      if (inTable && inTable !== el) return;

      if (el.getAttribute('role') === 'table') {
        const tableLines = parseTable(el);
        if (tableLines.length) lines.push('', ...tableLines, '');
        processed.add(el);
        return;
      }

      if (el.classList.contains('scriptor-paragraph') && el.closest('.scriptor-component-code-block')) return;
      const codeBlock = el.querySelector('.scriptor-code-wrap-on') ||
        (el.classList.contains('scriptor-component-code-block') ? el.querySelector('.scriptor-code-editor') : null);
      if (codeBlock) {
        const code = [...codeBlock.querySelectorAll('.scriptor-paragraph')].map(p => p.textContent).join('\n').trim() || codeBlock.textContent.trim();
        if (code) {
          const lang = detectCodeLanguage(code, el);
          lines.push('', '```' + lang, code, '```', '');
          codeTexts.add(normalize(code));
          codeRawTexts.add(code.replace(/\s+/g, ' ').trim());
          codeBlock.querySelectorAll('.scriptor-paragraph').forEach(p => processed.add(p));
          processed.add(el);
        }
        return;
      }

      const heading = el.getAttribute('role') === 'heading' ? el : el.querySelector('[role="heading"]');
      if (heading) {
        const level = parseInt(heading.getAttribute('aria-level') || '1', 10);
        let text = getTextContent(heading, true).replace(/\*\*/g, '').trim();
        if (text) lines.push('', `${'#'.repeat(Math.min(level, 6))} ${text}`, '');
        processed.add(el);
        return;
      }

      if (el.classList.contains('scriptor-listItem')) {
        const li = el.querySelector('li');
        if (!li) return;
        const text = getTextContent(li);
        if (!text) return;
        const margin = parseInt((el.getAttribute('style') || '').match(/margin-left:\s*(\d+)/)?.[1] || 0);
        const indent = '  '.repeat(Math.max(0, Math.floor((margin - 27) / 27)));
        const checkbox = li.querySelector('.scriptor-listItem-marker-checkbox');
        const checked = checkbox?.getAttribute('aria-checked') === 'true';
        const listParent = li.closest('ol, ul');
        const markerEl = el.querySelector('.scriptor-listItem-marker, [class*="listItem-marker"]');
        const markerText = markerEl?.textContent?.trim() || '';
        const hasNumberMarker = /^\d+[\.\)]?$/.test(markerText);
        const dataListType = el.getAttribute('data-list-type') || el.closest('[data-list-type]')?.getAttribute('data-list-type');
        const isOrdered = listParent?.tagName === 'OL' || hasNumberMarker || dataListType === 'ordered' || dataListType === 'number';
        let marker;
        if (checkbox) {
          marker = checked ? '- [x] ' : '- [ ] ';
        } else if (isOrdered) {
          const numMatch = markerText.match(/^(\d+)/);
          const value = numMatch ? numMatch[1] : (li.getAttribute('value') || '1');
          marker = `${value}. `;
        } else {
          marker = '- ';
        }
        lines.push(indent + marker + text);
        processed.add(el);
        return;
      }

      if (!el.closest('.scriptor-listItem') && !el.querySelector('.scriptor-code-wrap-on')) {
        // Check for images in this paragraph
        const imgs = el.querySelectorAll('img');
        if (imgs.length > 0) {
          for (const img of imgs) {
            const src = img.getAttribute('src');
            const alt = img.getAttribute('alt') || '';
            const altText = alt === 'Image has no description' ? '' : alt;
            if (src) lines.push('', `![${altText}](${src})`, '');
          }
          processed.add(el);
          return;
        }

        let text = getTextContent(el, true);
        text = normalize(text);
        const isCodeDuplicate = [...codeTexts].some(c => c.includes(text) || text.includes(c)) ||
          [...codeRawTexts].some(c => c.includes(text) || text.includes(c));
        if (text && !isCodeDuplicate) lines.push('', text, '');
        processed.add(el);
      }
    });
  });

  let markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, images: imageSources };
}

// --- File walking ---

function findHtmlFiles(dir, baseDir = dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...findHtmlFiles(fullPath, baseDir));
    } else if (entry.endsWith('.html')) {
      results.push({ fullPath, relPath: relative(baseDir, fullPath) });
    }
  }
  return results;
}

// --- Main ---

async function main() {
  log("📝 Loop HTML → Markdown Parser");
  log(`📂 Source: ${SRC}`);
  log(`📁 Destination: ${DEST}`);
  log("");

  const htmlFiles = findHtmlFiles(SRC);
  if (htmlFiles.length === 0) {
    log("❌ No HTML files found in source directory.");
    log("   Run 'node scrape.mjs' first to download pages from Loop.");
    process.exit(1);
  }

  log(`Found ${htmlFiles.length} HTML files`);
  log("─────────────────────────────────");

  let converted = 0;
  let imgSaved = 0;

  for (const { fullPath, relPath } of htmlFiles) {
    const mdRelPath = relPath.replace(/\.html$/, '.md');
    const outputPath = join(DEST, mdRelPath);
    const outputDir = dirname(outputPath);

    log(`📄 ${mdRelPath}`);

    try {
      const html = readFileSync(fullPath, 'utf-8');
      const { markdown, images } = convertHtmlToMarkdown(html);

      if (!markdown && images.length === 0) {
        log("   ⚠️  No content, skipping");
        continue;
      }

      // Save images (base64 → local files, HTTP URLs → check if already downloaded)
      let finalMarkdown = markdown || '';
      if (images.length > 0) {
        const assetsDir = join(outputDir, "_assets");
        // Check if scraper already downloaded images to source _assets dir
        const srcAssetsDir = join(dirname(fullPath), "_assets");
        mkdirSync(assetsDir, { recursive: true });
        let imgIdx = 0;
        for (const imgSrc of images) {
          imgIdx++;
          if (imgSrc.startsWith("data:image")) {
            const mimeMatch = imgSrc.match(/^data:image\/([\w+]+);base64,/);
            if (!mimeMatch) continue;
            const ext = mimeMatch[1].replace("+xml", "");
            const imgName = `image_${imgIdx}.${ext}`;
            const localImgPath = join(assetsDir, imgName);
            const b64Data = imgSrc.slice(imgSrc.indexOf(",") + 1);
            writeFileSync(localImgPath, Buffer.from(b64Data, "base64"));
            finalMarkdown = finalMarkdown.replaceAll(imgSrc, `_assets/${imgName}`);
            imgSaved++;
          } else if (imgSrc.startsWith("http")) {
            // Check if the scraper already downloaded this image
            let imgName = basename(new URL(imgSrc).pathname) || `image_${imgIdx}`;
            if (!extname(imgName)) imgName += ".png";
            imgName = imgName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
            const srcImgPath = join(srcAssetsDir, imgName);
            if (existsSync(srcImgPath)) {
              // Copy from source _assets to output _assets
              const imgData = readFileSync(srcImgPath);
              writeFileSync(join(assetsDir, imgName), imgData);
              finalMarkdown = finalMarkdown.replaceAll(imgSrc, `_assets/${imgName}`);
              imgSaved++;
            }
            // If not downloaded, leave URL as-is in markdown
          }
        }
      }

      mkdirSync(outputDir, { recursive: true });
      writeFileSync(outputPath, finalMarkdown, "utf-8");
      converted++;
    } catch (err) {
      log(`   ⚠️  Error: ${err.message.split('\n')[0]}`);
    }
  }

  log("");
  log("─────────────────────────────────");
  log("✅ Done!");
  log(`   📄 Converted: ${converted} files`);
  log(`   🖼️  Images saved: ${imgSaved}`);
  log(`   📁 Output: ${DEST}`);
}

// Only run main when executed directly (not imported)
import { fileURLToPath } from "url";
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error("💥 Fatal error:", err.message);
    process.exit(1);
  });
}
