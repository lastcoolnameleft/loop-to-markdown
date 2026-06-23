#!/usr/bin/env node
/**
 * Test scraping a single Loop page to verify formatting.
 * Usage: node test-single.mjs [page-url]
 * 
 * If no URL provided, navigates to "My workspace" landing page.
 * Saves both raw HTML and parsed markdown for inspection.
 */

import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "fs";
import { resolve } from "path";
import { JSDOM } from "jsdom";

const AUTH_DIR = resolve(".auth");
const args = process.argv.slice(2);
const targetUrl = args[0] || null;

// Import the parser inline (same logic as parse.mjs)
async function main() {
  // If --parse-only flag, just re-parse existing test-output.html
  if (args.includes("--parse-only")) {
    const html = readFileSync("test-output.html", "utf-8");
    const { convertHtmlToMarkdown } = await import("./parse.mjs");
    const { markdown } = convertHtmlToMarkdown(html);
    writeFileSync("test-output.md", markdown, "utf-8");
    console.log(`📄 Parsed ${html.length} chars HTML → ${markdown.length} chars MD`);
    console.log(`\n--- First 80 lines ---\n`);
    console.log(markdown.split("\n").slice(0, 80).join("\n"));
    return;
  }

  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    headless: false,
    channel: "msedge",
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  let url = targetUrl;
  if (!url) {
    await page.goto("https://loop.cloud.microsoft/", { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForTimeout(5000);
    await page.locator('h3:has-text("My workspace")').click();
    await page.waitForTimeout(5000);
    url = page.url();
    console.log("Using workspace landing page:", url);
  } else {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  await page.waitForSelector('[contenteditable="true"]', { timeout: 15_000 });
  await page.waitForTimeout(2000);

  // Force content render + scroll
  await page.evaluate(async () => {
    document.querySelectorAll('.scriptor-pageFrame').forEach(el => {
      el.style.contentVisibility = 'visible';
      el.style.containIntrinsicHeight = 'auto';
    });
    const editor = document.querySelector('[contenteditable="true"]');
    if (!editor) return;
    const scrollContainer = editor.closest('[data-overlayscrollbars-viewport]') || editor.parentElement;
    if (!scrollContainer) return;
    let prevHeight = 0;
    for (let i = 0; i < 30; i++) {
      scrollContainer.scrollTop = scrollContainer.scrollHeight;
      await new Promise(r => setTimeout(r, 200));
      if (scrollContainer.scrollHeight === prevHeight) break;
      prevHeight = scrollContainer.scrollHeight;
    }
    scrollContainer.scrollTop = 0;
    await new Promise(r => setTimeout(r, 300));
  });

  // Extract raw HTML
  const rawHtml = await page.evaluate(() => {
    const editables = document.querySelectorAll('[contenteditable="true"]');
    let best = null;
    let bestLen = 0;
    for (const el of editables) {
      const len = el.innerHTML.length;
      if (len > bestLen) { bestLen = len; best = el; }
    }
    if (!best) return null;
    const frames = best.querySelectorAll('.scriptor-pageFrame');
    if (frames.length > 0) {
      return [...frames].map(f => f.outerHTML).join('\n');
    }
    return best.innerHTML;
  });

  await context.close();

  if (!rawHtml) {
    console.error("No content found!");
    process.exit(1);
  }

  writeFileSync("test-output.html", rawHtml, "utf-8");
  console.log(`\n📝 Raw HTML saved to test-output.html (${rawHtml.length} chars)`);

  // Parse with JSDOM
  const { convertHtmlToMarkdown } = await import("./parse.mjs");
  const { markdown, images } = convertHtmlToMarkdown(rawHtml);

  console.log(`🖼️  Found ${images.length} images`);
  writeFileSync("test-output.md", markdown, "utf-8");
  console.log(`📄 Markdown saved to test-output.md (${markdown.length} chars)`);
  console.log(`\n--- First 80 lines ---\n`);
  console.log(markdown.split("\n").slice(0, 80).join("\n"));
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
