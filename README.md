# loop-to-markdown

Scrape an entire Microsoft Loop workspace into local Markdown files with images.

## How It Works

This tool uses a **two-phase architecture**:

1. **`scrape.mjs`** — Uses Playwright to authenticate with your Microsoft account, discover all pages in a Loop workspace, and download the raw HTML + images locally.
2. **`parse.mjs`** — Converts the saved HTML files to clean Markdown using JSDOM. No browser needed, runs instantly, and can be re-run as many times as needed without re-downloading.

This separation means you only need to scrape once (slow, requires auth) and can iterate on the Markdown conversion (fast, offline) as much as you want.

## Features

- 🔐 Persistent browser authentication (sign in once, reuse for ~1 week)
- 📂 Preserves full page hierarchy (folders → subdirectories)
- 🖼️ Downloads images (both HTTP URLs and base64-embedded)
- ✅ Handles checkboxes, tables, code blocks, headings, bold, links, @mentions
- 📋 Proper nested list indentation (Loop's unusual `margin-left` rendering)
- 💥 Crash recovery (handles Loop's "Reload to continue" dialogs)
- 🚀 Content virtualization workaround (forces all content to render)

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A Microsoft account with access to Loop

## Setup

```bash
git clone https://github.com/lastcoolnameleft/loop-to-markdown.git
cd loop-to-markdown
npm install
npx playwright install chromium
```

## Usage

### 1. Scrape your workspace

```bash
# First run opens a browser for sign-in (interactive)
npm run scrape:headed

# Subsequent runs can be headless (auth is cached)
npm run scrape
```

HTML files and images are saved to `loop-backup/`.

### 2. Convert to Markdown

```bash
npm run parse
```

Markdown files and images are saved to `loop-md/`.

### 3. Test a single page

```bash
# Scrape and parse one page (by URL)
node test-single.mjs "https://loop.cloud.microsoft/p/eyJ..."

# Re-parse an already-downloaded HTML file
node test-single.mjs --parse-only "loop-backup/My Folder/Page.html"
```

## CLI Options

### scrape.mjs

| Flag | Description |
|------|-------------|
| `--headed` | Run browser visibly (required for first-time sign-in) |
| `--limit N` | Only scrape the first N pages |
| `--dest <dir>` | Output directory (default: `loop-backup`) |
| `--workspace <name>` | Target a specific workspace by name |

### parse.mjs

| Flag | Description |
|------|-------------|
| `--src <dir>` | Source HTML directory (default: `loop-backup`) |
| `--dest <dir>` | Output directory (default: `loop-md`) |

## Output Structure

```
loop-md/
├── Folder A/
│   ├── Page 1.md
│   ├── Page 2.md
│   └── _assets/
│       ├── image_1.png
│       └── image_2.png
├── Folder B/
│   └── Nested Folder/
│       └── Page 3.md
└── Top-Level Page.md
```

## How Loop Renders Content

Loop has some unusual DOM patterns that this tool handles:

- **Lists**: Each bullet is a separate `<ul>` inside a `<div>` with `margin-left` for indentation
- **Virtualization**: Uses `content-visibility: auto` to skip rendering off-screen content
- **Flat tree**: The page tree sidebar is flat — hierarchy comes from `aria-level` attributes
- **Crash dialogs**: Rapid navigation triggers "Reload to continue" errors

## Credits

The Markdown conversion logic is adapted from [oztalha/loop-to-markdown](https://github.com/oztalha/loop-to-markdown), a Tampermonkey userscript that handles Loop's native DOM structure.

## License

GPL-3.0 — see [LICENSE](LICENSE). The Markdown conversion logic is adapted from [oztalha/loop-to-markdown](https://github.com/oztalha/loop-to-markdown) (GPL-3.0).
