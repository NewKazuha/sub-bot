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
 * Drop every reference to the shared browser. Idempotent: safe to call from
 * the crash handler, from the launcher failure path and from closeBrowser().
 */
function resetBrowserState() {
  browser = null;
  browserContext = null;
  contextPromise = null;
}

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

// Every host owned by Rocks-Team: the blog (www.rocks-team.net) and the DDL
// index (ddl.rocks-team.net) share the same Cloudflare challenge.
const ROCKS_HOSTS = new Set(['ddl.rocks-team.net', 'www.rocks-team.net', 'rocks-team.net']);

/**
 * True for any Rocks-Team owned host (blog + DDL index).
 */
export function isRocksHost(url) {
  try { return ROCKS_HOSTS.has(new URL(url).hostname.toLowerCase()); } catch { return false; }
}

async function getContext() {
  if (browserContext) {
    // A context whose browser died (crash / external kill) is dead itself:
    // drop it instead of handing out a broken context.
    if (browser && browser.isConnected()) return browserContext;
    resetBrowserState();
  }
  if (!contextPromise) {
    contextPromise = (async () => {
      // Imported lazily so that merely importing this module never requires a
      // working Chromium install (and never slows down unrelated code paths).
      const { chromium } = await import('playwright');
      const launched = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
      // If Chromium dies on its own, the context dies with it. Reset only when
      // the dead browser is still the current one, so a newer browser is never
      // wiped by a late event from an older instance.
      launched.once('disconnected', () => {
        if (browser === launched) resetBrowserState();
      });
      const context = await launched.newContext({
        userAgent: UA,
        viewport: { width: 1366, height: 768 }
      });
      browser = launched;
      browserContext = context;
      return context;
    })().catch(err => {
      resetBrowserState();
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
      () => document.querySelectorAll('a[href*=".rar"],a[href*=".ass"],a[href*=".zip"],a[href*="ddl.rocks-team.net"]').length > 0,
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
 * Download a file through Chromium's real download pipeline (the browser's own
 * TLS/HTTP stack with its full fingerprint, so Cloudflare lets it through).
 * `context.request` uses Node's HTTP stack and gets 403'd.
 * Returns true on success, false on failure (never throws).
 */
export async function downloadViaBrowser(url, destPath) {
  let page = null;
  try {
    const context = await getContext();
    page = await context.newPage();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 120000 }),
      page.goto(url).catch(() => {}) // the download aborts navigation; failure is expected
    ]);
    const failure = await download.failure();
    if (failure) {
      console.warn(`[browser-fetch] Download failed for ${url}: ${failure}`);
      return false;
    }
    await download.saveAs(destPath);
    // Cloudflare challenge pages are sometimes saved as files. Preserve the old
    // HTML content-type guard by checking the first bytes on disk.
    const fh = await fs.open(destPath, 'r');
    try {
      const buf = Buffer.alloc(8);
      const { bytesRead } = await fh.read(buf, 0, 8, 0);
      if (bytesRead < 4) {
        console.warn(`[browser-fetch] Refusing empty/truncated download for ${url}`);
        await fs.unlink(destPath).catch(() => {});
        return false;
      }
      const head = buf.subarray(0, bytesRead).toString('latin1').trimStart();
      if (head.startsWith('<')) {
        console.warn(`[browser-fetch] Refusing HTML download for ${url} (starts with ${JSON.stringify(head.slice(0, 8))})`);
        await fs.unlink(destPath).catch(() => {});
        return false;
      }
    } finally {
      await fh.close();
    }
    return true;
  } catch (e) {
    console.warn(`[browser-fetch] Browser download failed for ${url}:`, e.message);
    return false;
  } finally {
    if (page) { try { await page.close(); } catch { } }
  }
}

/**
 * Close the shared browser and reset the singleton so the next round starts
 * from a clean browser (used at the end of a monitoring round).
 */
export async function closeBrowser() {
  let current = null;
  try {
    // Wait for a launch that is still in flight so we never leak a browser.
    if (contextPromise) await contextPromise.catch(() => { });
    current = browser;
  } catch (e) {
    console.warn('[browser-fetch] Failed to close the headless browser:', e.message);
  } finally {
    // Idempotent: clears the singleton so the next round starts from a clean
    // browser, whether or not the close below succeeded.
    resetBrowserState();
  }
  if (current) {
    try {
      await current.close();
    } catch (e) {
      console.warn('[browser-fetch] Failed to close the headless browser:', e.message);
    }
  }
}
