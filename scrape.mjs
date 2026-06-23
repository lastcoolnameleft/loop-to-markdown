#!/usr/bin/env node
/**
 * Loop Workspace Scraper
 * Uses Playwright to navigate Microsoft Loop "My Workspace",
 * traverse the page tree (including subfolders), and export as clean Markdown.
 *
 * Markdown conversion runs in-browser using DOM parsing (inspired by
 * github.com/oztalha/loop-to-markdown) to avoid lazy-loading issues.
 *
 * Usage:
 *   node scrape.mjs [--dest ./loop-backup] [--headed] [--workspace "My workspace"] [--limit N]
 *
 * On first run, a browser opens for you to sign in.
 * Your session is saved in .auth/ so subsequent runs are automatic.
 */

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";
import { join, resolve, basename, extname } from "path";

// --- Config ---
const args = process.argv.slice(2);
const headed = args.includes("--headed");
const destIdx = args.indexOf("--dest");
const DEST = resolve(destIdx !== -1 ? args[destIdx + 1] : "./loop-backup");
const wsIdx = args.indexOf("--workspace");
const TARGET_WORKSPACE = wsIdx !== -1 ? args[wsIdx + 1] : "My workspace";
const limitIdx = args.indexOf("--limit");
const PAGE_LIMIT = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;
const AUTH_DIR = resolve(".auth");
const LOOP_BASE = "https://loop.cloud.microsoft";

// --- Helpers ---
function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
}

function log(msg) {
  console.log(msg);
}

// --- Main ---
async function main() {
  log("🚀 Loop Workspace Scraper");
  log(`📁 Destination: ${DEST}`);
  log(`📂 Target workspace: "${TARGET_WORKSPACE}"`);
  log("");

  mkdirSync(AUTH_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(AUTH_DIR, {
    headless: !headed,
    channel: "msedge",
    viewport: { width: 1280, height: 900 },
  });

  const page = await context.newPage();

  // Navigate to Loop home
  log("🔐 Navigating to Loop...");
  await page.goto(LOOP_BASE, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(3000);

  // Check if sign-in is needed
  const signInBtn = page.locator('button:has-text("Sign in")').first();
  if (await signInBtn.isVisible()) {
    log("⚠️  Sign-in required! Browser will open for authentication.");
    log("   Complete sign-in, then the script will continue...");

    // If headless, relaunch headed for auth
    if (!headed) {
      await context.close();
      const authCtx = await chromium.launchPersistentContext(AUTH_DIR, {
        headless: false,
        channel: "msedge",
        viewport: { width: 1280, height: 900 },
      });
      const authPage = await authCtx.newPage();
      await authPage.goto(LOOP_BASE, { waitUntil: "networkidle", timeout: 60_000 });
      await authPage.locator('button:has-text("Sign in")').first().click();
      await authPage.waitForURL(/loop\.cloud\.microsoft(?!.*\/learn)/, { timeout: 300_000 });
      log("✅ Signed in! Session saved.");
      await authCtx.close();

      // Relaunch in original mode
      const ctx2 = await chromium.launchPersistentContext(AUTH_DIR, {
        headless: true,
        channel: "msedge",
        viewport: { width: 1280, height: 900 },
      });
      return await scrapeWorkspace(ctx2);
    }

    await signInBtn.click();
    await page.waitForURL(/loop\.cloud\.microsoft(?!.*\/learn)/, { timeout: 300_000 });
    log("✅ Signed in!");
  }

  await scrapeWorkspace(context);
}

async function scrapeWorkspace(context) {
  const page = (await context.pages())[0] || (await context.newPage());

  // Go to Loop home and click into target workspace
  log("📂 Opening workspace...");
  await page.goto(LOOP_BASE, { waitUntil: "networkidle", timeout: 60_000 });
  await page.waitForTimeout(3000);

  const wsCard = page.locator(`h3:has-text("${TARGET_WORKSPACE}")`);
  if (!(await wsCard.isVisible())) {
    log(`❌ Workspace "${TARGET_WORKSPACE}" not found on home page.`);
    await context.close();
    process.exit(1);
  }
  await wsCard.click();
  await page.waitForTimeout(5000);
  await dismissDialogs(page);

  log("🔍 Discovering page tree...");

  // Recursively discover all pages from the sidebar tree
  const allPages = await discoverTree(page);
  log(`✅ Found ${allPages.length} pages`);
  log("");

  if (allPages.length === 0) {
    log("❌ No pages found.");
    await context.close();
    process.exit(1);
  }

  // Export each page by navigating directly to its URL
  log("⬇️  Downloading page HTML...");
  log("─────────────────────────────────");

  let downloaded = 0;
  let skipped = 0;
  let imgDownloaded = 0;

  for (const entry of allPages) {
    if (downloaded >= PAGE_LIMIT) {
      log(`\n🛑 Reached --limit ${PAGE_LIMIT}, stopping.`);
      break;
    }
    const relPath = entry.path.map(sanitizeFilename).join("/");
    const fileName = sanitizeFilename(entry.name) + ".html";
    const localDir = relPath ? join(DEST, relPath) : DEST;
    const outputPath = join(localDir, fileName);
    const displayPath = relPath ? `${relPath}/${fileName}` : fileName;

    log(`📄 ${displayPath}`);

    try {
      // Load page with retry on "Reload to continue" errors
      let loaded = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.goto(entry.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

        const needsReload = await dismissDialogs(page);
        if (needsReload) {
          log(`   ⟳ Loop crashed, retrying (attempt ${attempt + 2}/3)...`);
          await page.waitForTimeout(2000);
          continue;
        }

        await page.waitForSelector('[contenteditable="true"]', { timeout: 15_000 });
        await page.waitForTimeout(2000);

        if (await dismissDialogs(page)) {
          log(`   ⟳ Loop crashed after render, retrying...`);
          await page.waitForTimeout(2000);
          continue;
        }

        loaded = true;
        break;
      }

      if (!loaded) {
        log("   ⚠️  Loop kept crashing, skipping");
        skipped++;
        continue;
      }

      // Force content-visibility and scroll to render all virtualized content
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

      // Extract raw HTML from the page content area
      const rawHtml = await page.evaluate(() => {
        const editables = document.querySelectorAll('[contenteditable="true"]');
        let best = null;
        let bestLen = 0;
        for (const el of editables) {
          const len = el.innerHTML.length;
          if (len > bestLen) { bestLen = len; best = el; }
        }
        if (!best) return null;
        // Get the outerHTML of all page frames (preserves full structure)
        const frames = best.querySelectorAll('.scriptor-pageFrame');
        if (frames.length > 0) {
          return [...frames].map(f => f.outerHTML).join('\n');
        }
        return best.innerHTML;
      });

      if (!rawHtml || rawHtml.length < 10) {
        log("   ⚠️  No content found, skipping");
        skipped++;
        continue;
      }

      mkdirSync(localDir, { recursive: true });
      writeFileSync(outputPath, rawHtml, "utf-8");

      // Download images (HTTP URLs need authenticated session)
      const imageUrls = await page.evaluate(() => {
        const imgs = [...document.querySelectorAll('.scriptor-pageFrame img, [contenteditable="true"] img')];
        return imgs
          .map(img => img.getAttribute('src'))
          .filter(src => src && src.startsWith('http'));
      });

      if (imageUrls.length > 0) {
        const assetsDir = join(localDir, "_assets");
        mkdirSync(assetsDir, { recursive: true });
        let imgIdx = 0;
        for (const imgSrc of imageUrls) {
          try {
            imgIdx++;
            let imgName = basename(new URL(imgSrc).pathname) || `image_${imgIdx}`;
            if (!extname(imgName)) imgName += ".png";
            imgName = imgName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
            const localImgPath = join(assetsDir, imgName);
            const response = await page.request.get(imgSrc);
            if (response.ok()) {
              writeFileSync(localImgPath, await response.body());
              imgDownloaded++;
            }
          } catch {
            // Non-fatal
          }
        }
      }

      downloaded++;
    } catch (err) {
      log(`   ⚠️  Error: ${err.message.split('\n')[0]}`);
      skipped++;
    }

    // Throttle to avoid overwhelming Loop
    await page.waitForTimeout(1000);
  }

  log("");
  log("─────────────────────────────────");
  log("✅ Done!");
  log(`   📄 Downloaded: ${downloaded} HTML files`);
  log(`   🖼️  Images: ${imgDownloaded}`);
  log(`   ⏭️  Skipped: ${skipped} files`);
  log(`   📁 Location: ${DEST}`);
  log("");
  log("Next: run 'node parse.mjs' to convert HTML → Markdown");

  await context.close();
}

/**
 * Dismiss any modal dialogs/overlays that Loop might show.
 * Returns true if a "Reload to continue" dialog was found (page needs reload).
 */
async function dismissDialogs(page) {
  let needsReload = false;

  // Check for "Reload to continue" error dialog
  const reloadDialog = page.locator('text="Reload to continue"');
  if (await reloadDialog.isVisible({ timeout: 500 }).catch(() => false)) {
    needsReload = true;
    const closeBtn = page.locator('button:has-text("Close")').first();
    if (await closeBtn.isVisible({ timeout: 500 }).catch(() => false)) {
      await closeBtn.click();
      await page.waitForTimeout(500);
    }
  }

  // Generic backdrop dismiss
  const backdrop = page.locator('.fui-DialogSurface__backdrop');
  if (await backdrop.isVisible({ timeout: 300 }).catch(() => false)) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  // Dismiss common buttons
  for (const label of ["Close", "Got it", "Dismiss", "Not now"]) {
    const btn = page.locator(`button:has-text("${label}")`).first();
    if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
      await btn.click();
      await page.waitForTimeout(300);
    }
  }

  return needsReload;
}

/**
 * Expand all collapsible folders in the page tree sidebar.
 */
async function expandAllFolders(page) {
  await dismissDialogs(page);
  // Repeatedly find and expand collapsed folders until no new items appear
  for (let pass = 0; pass < 10; pass++) {
    const beforeCount = await page.locator('[data-testid^="PageSubtree_"]').count();

    // Find all tree items that have chevrons (folders) and check if collapsed
    // A folder is collapsed if the NEXT sibling subtree doesn't have a higher aria-level
    const collapsedFolderIds = await page.evaluate(() => {
      const ids = [];
      const subtrees = [...document.querySelectorAll('[data-testid^="PageSubtree_"]')];
      for (let i = 0; i < subtrees.length; i++) {
        const st = subtrees[i];
        const hasChevron = !!st.querySelector('[data-testid="CollapsiblePageChevron"]');
        if (!hasChevron) continue;

        const treeItem = st.querySelector("[role=treeitem]");
        const myLevel = parseInt(treeItem?.getAttribute("aria-level") || "1", 10);

        // Check if next item exists and has a higher level (meaning folder is expanded)
        const next = subtrees[i + 1];
        if (next) {
          const nextTreeItem = next.querySelector("[role=treeitem]");
          const nextLevel = parseInt(nextTreeItem?.getAttribute("aria-level") || "1", 10);
          if (nextLevel > myLevel) continue; // Already expanded
        }

        // This folder appears collapsed
        const pageId = st.getAttribute("data-testid").replace("PageSubtree_", "");
        ids.push(pageId);
      }
      return ids;
    });

    if (collapsedFolderIds.length === 0) break;

    // Click each collapsed folder's chevron
    for (const pageId of collapsedFolderIds) {
      const chevron = page.locator(
        `[data-testid="PageSubtree_${pageId}"] [data-testid="CollapsiblePageChevron"]`
      ).first();
      if (await chevron.isVisible({ timeout: 500 }).catch(() => false)) {
        await chevron.click({ force: true, timeout: 1000 }).catch(() => {});
        await page.waitForTimeout(600);
      }
    }

    await page.waitForTimeout(500);
    const afterCount = await page.locator('[data-testid^="PageSubtree_"]').count();
    if (afterCount > beforeCount) {
      log(`   Expanded (pass ${pass + 1}): ${beforeCount} → ${afterCount} items`);
    }
    if (afterCount === beforeCount) break;
  }
}

/**
 * Discover all pages in the sidebar tree.
 * The tree is flat in the DOM — hierarchy comes from aria-level on [role=treeitem].
 * Expands all folders, collects items with levels, builds path from level stack.
 * Then clicks each to capture its URL.
 * Returns array of { name, url, path[] }
 */
async function discoverTree(page) {
  const results = [];

  const treeEl = page.locator('[data-testid="page-tree"]');
  if (!(await treeEl.isVisible())) {
    log("   ⚠️  page-tree not found");
    return results;
  }

  // Expand all collapsible folders
  await expandAllFolders(page);

  // Collect all tree items in DOM order with their aria-level
  const allItems = await page.evaluate(() => {
    const items = [];
    const subtrees = document.querySelectorAll('[data-testid^="PageSubtree_"]');
    for (const st of subtrees) {
      const pageId = st.getAttribute("data-testid").replace("PageSubtree_", "");
      const nameEl = st.querySelector(`[data-testid="${pageId}"]`);
      const name = nameEl?.textContent?.replace(/\d+$/, "").trim() || "";
      const treeItem = st.querySelector("[role=treeitem]");
      const level = parseInt(treeItem?.getAttribute("aria-level") || "1", 10);
      const hasChevron = !!st.querySelector('[data-testid="CollapsiblePageChevron"]');
      if (name) {
        items.push({ pageId, name, level, hasChevron });
      }
    }
    return items;
  });

  // Build path for each item based on level + preceding folder items
  // Level 1 = root, level 2 = inside a level-1 folder, etc.
  const pathStack = []; // stack of { name, level } for current folder ancestry
  const itemsWithPath = [];

  for (const item of allItems) {
    // Pop stack down to parent level
    while (pathStack.length > 0 && pathStack[pathStack.length - 1].level >= item.level) {
      pathStack.pop();
    }

    const path = pathStack.map((p) => p.name);
    itemsWithPath.push({ ...item, path });

    // If this item has children (is a folder), push it onto the stack
    if (item.hasChevron) {
      pathStack.push({ name: item.name, level: item.level });
    }
  }

  log(`   Found ${itemsWithPath.length} tree items, capturing URLs...`);

  // Click each page to capture its URL, navigating back when items become hidden
  const workspaceUrl = page.url();

  for (let i = 0; i < itemsWithPath.length; i++) {
    const item = itemsWithPath[i];
    try {
      const pageEl = page.locator(`[data-testid="${item.pageId}"]`).first();

      if (!(await pageEl.isVisible({ timeout: 1000 }).catch(() => false))) {
        // Navigate back and re-expand
        await page.goto(workspaceUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
        await page.waitForSelector('[data-testid="page-tree"]', { timeout: 10_000 });
        await page.waitForTimeout(2000);
        await expandAllFolders(page);
      }

      await pageEl.scrollIntoViewIfNeeded({ timeout: 3000 });
      await pageEl.click({ force: true, timeout: 3000 });
      await page.waitForTimeout(1200);

      const url = page.url();
      if (url.includes("/p/")) {
        results.push({ name: item.name, url, path: item.path });
      }
    } catch (err) {
      log(`   ⚠️  Skip "${item.name}": ${err.message.split('\n')[0]}`);
    }

    if ((i + 1) % 10 === 0) {
      log(`   ... ${i + 1}/${itemsWithPath.length} discovered`);
    }
  }

  return results;
}

main().catch((err) => {
  console.error("💥 Fatal error:", err.message);
  process.exit(1);
});
