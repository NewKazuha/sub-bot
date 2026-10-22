import fs from 'node:fs/promises';

// Rocks-Team DDL (ddl.rocks-team.net) sits behind a Cloudflare challenge that
// rejects plain HTTP clients, so the listing must be rendered by a real browser
// and the file must be fetched with the cookies the browser obtained.
const ROCKS_DDL_HOST = 'ddl.rocks-team.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const LAUNCH_ARGS = ['--no-sandbox', '--disable-dev-shm-usage'];

// One browser + one context for the whole process: launching Chromium per URL
// costs seconds each time. The context also carries the Cloudflare clearance
// cookie, so `context.request` can reuse it for the file download.
let browser = null;
let browserContext = null;
let contextPromise = null;

/**
 * True only for the Rocks-Team DDL host (exact hostname match).
 */
export function isRocksDdlHost(url) {
  try {
    return new URL(url).hostname.toLowerCase() === ROCKS_DDL_HOST;
  } catch {
    return false;
  }
}

async function getContext() {
  if (browserContext) return browserContext;
  if (!contextPromise) {
    contextPromise = (async () => {
      // Imported lazily so that merely importing this module never requires a
      // working Chromium install (and never slows down unrelated code paths).
      const { chromium } = await import('playwright');
      const launched = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
      const context = await launched.newContext({
        userAgent: UA,
        viewport: { width: 1366, height: 768 }
      });
      browser = launched;
      browserContext = context;
      return context;
    })().catch(err => {
      contextPromise = null;
      browser = null;
      browserContext = null;
      throw err;
    });
  }
  return contextPromise;
}

/**
 * Render a page in headless Chromium and return its final HTML.
 * Returns null (never throws) when the page cannot be loaded.
 */
export async function fetchRenderedHtml(url, { timeoutMs = 45000 } = {}) {
  let page = null;
  try {
    const context = await getContext();
    page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // The listing is rendered client-side: wait for the file links to appear
    // instead of guessing with a fixed sleep.
    await page.waitForFunction(
      () => document.querySelectorAll('a[href*=".rar"],a[href*=".ass"],a[href*=".zip"]').length > 0,
      null,
      { timeout: timeoutMs }
    );
    return await page.content();
  } catch (e) {
    console.warn(`[browser-fetch] Could not render ${url}:`, e.message);
    return null;
  } finally {
    if (page) {
      try { await page.close(); } catch { }
    }
  }
}

/**
 * Download a file with the browser context's cookie jar (cf_clearance).
 * Returns true on success, false on failure (never throws).
 */
export async function downloadViaBrowser(url, destPath) {
  try {
    const context = await getContext();
    const response = await context.request.get(url);
    if (!response.ok()) {
      console.warn(`[browser-fetch] Browser download failed for ${url}: HTTP ${response.status()}`);
      return false;
    }
    const body = await response.body();
    await fs.writeFile(destPath, body);
    return true;
  } catch (e) {
    console.warn(`[browser-fetch] Browser download failed for ${url}:`, e.message);
    return false;
  }
}

/**
 * Close the shared browser and reset the singleton so the next round starts
 * from a clean browser (used at the end of a monitoring round).
 */
export async function closeBrowser() {
  try {
    // Wait for a launch that is still in flight so we never leak a browser.
    if (contextPromise) await contextPromise.catch(() => { });
    const current = browser;
    browser = null;
    browserContext = null;
    contextPromise = null;
    if (current) {
      await current.close();
    }
  } catch (e) {
    console.warn('[browser-fetch] Failed to close the headless browser:', e.message);
  }
}
