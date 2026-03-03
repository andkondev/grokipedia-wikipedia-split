const CONTEXT_MENU_WIKI = 'grokipedia-split-view-wiki';
const CONTEXT_MENU_GROKI = 'grokipedia-split-view-groki';
const NAVIGATION_TIMEOUT_MS = 15000;
const WIKIPEDIA_TARGET_CACHE_TTL_MS = 8000;
const PIN_REMINDER_SHOWN_KEY = 'pinReminderShown';
const PIN_REMINDER_PENDING_KEY = 'pinReminderPending';
const LOWERCASE_WIKI_WORDS = new Set([
  'of',
  'the',
  'and',
  'in',
  'on',
  'at',
  'to',
  'for',
  'with',
  'a',
  'an'
]);

const pendingNavigations = new Map();
const wikipediaTargetCacheByTab = new Map();
const wikipediaTargetInflightByKey = new Map();
let contextMenuMutationQueue = Promise.resolve();
let pinReminderShouldShowCache = null;

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isWikipediaHost(hostname) {
  return hostname === 'en.wikipedia.org';
}

function isGrokipediaHost(hostname) {
  return hostname === 'grokipedia.com';
}

function isWikipediaArticlePath(pathname) {
  return pathname.startsWith('/wiki/') && pathname.length > '/wiki/'.length;
}

function isGrokipediaArticlePath(pathname) {
  return pathname.startsWith('/page/') && pathname.length > '/page/'.length;
}

function getWikipediaArticleUrl(urlValue) {
  const parsed = parseUrl(urlValue || '');
  if (
    !parsed ||
    parsed.protocol !== 'https:' ||
    !isWikipediaHost(parsed.hostname) ||
    !isWikipediaArticlePath(parsed.pathname)
  ) {
    return null;
  }

  parsed.hash = '';
  return parsed.toString();
}

function normalizeUrlForComparison(urlValue) {
  const parsed = parseUrl(urlValue || '');
  if (!parsed) {
    return '';
  }

  parsed.hash = '';
  if (parsed.pathname.length > 1) {
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  }

  if (isWikipediaHost(parsed.hostname) && isWikipediaArticlePath(parsed.pathname)) {
    const article = safeDecodeURIComponent(parsed.pathname.slice('/wiki/'.length))
      .replace(/\s+/g, '_')
      .trim();
    parsed.pathname = `/wiki/${encodePathPreservingSlashes(article)}`;
    parsed.search = '';
  }

  if (isGrokipediaHost(parsed.hostname) && isGrokipediaArticlePath(parsed.pathname)) {
    const article = safeDecodeURIComponent(parsed.pathname.slice('/page/'.length))
      .replace(/\s+/g, '_')
      .trim();
    parsed.pathname = `/page/${encodePathPreservingSlashes(article)}`;
  }

  return parsed.toString();
}

function urlsEquivalent(left, right) {
  return normalizeUrlForComparison(left) === normalizeUrlForComparison(right);
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodePathPreservingSlashes(path) {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function toWikipediaTitleCase(article) {
  return article
    .split('_')
    .map((word, index) => {
      if (!word) {
        return word;
      }

      if (/^[ivxlcdm]+$/i.test(word)) {
        return word.toUpperCase();
      }

      const lowerWord = word.toLowerCase();
      const isAllLower = word === lowerWord;

      if (index > 0 && isAllLower && LOWERCASE_WIKI_WORDS.has(lowerWord)) {
        return lowerWord;
      }

      if (index === 0 && isAllLower) {
        return lowerWord.charAt(0).toUpperCase() + lowerWord.slice(1);
      }

      return word;
    })
    .join('_');
}

async function getSplitState() {
  return chrome.storage.local.get(['splitTabId', 'wikipediaUrl', 'wikipediaFrameUrl']);
}

async function setSplitState(tabId, wikipediaUrl = null, wikipediaFrameUrl = wikipediaUrl) {
  await chrome.storage.local.set({
    splitTabId: tabId,
    wikipediaUrl,
    wikipediaFrameUrl
  });
}

async function clearSplitState() {
  await chrome.storage.local.set({
    splitTabId: null,
    wikipediaUrl: null,
    wikipediaFrameUrl: null
  });
}

function getArticleCacheKey(article) {
  return article
    .replace(/\s+/g, '_')
    .trim()
    .toLowerCase();
}

function clearWikipediaTargetCacheForTab(tabId) {
  if (typeof tabId !== 'number') {
    return;
  }

  wikipediaTargetCacheByTab.delete(tabId);

  const keyPrefix = `${tabId}:`;
  for (const key of wikipediaTargetInflightByKey.keys()) {
    if (key.startsWith(keyPrefix)) {
      wikipediaTargetInflightByKey.delete(key);
    }
  }
}

async function shouldShowPinReminder() {
  if (typeof pinReminderShouldShowCache === 'boolean') {
    return pinReminderShouldShowCache;
  }

  const result = await chrome.storage.local.get([
    PIN_REMINDER_SHOWN_KEY,
    PIN_REMINDER_PENDING_KEY
  ]);

  const shouldShow =
    result[PIN_REMINDER_PENDING_KEY] === true &&
    result[PIN_REMINDER_SHOWN_KEY] !== true;
  pinReminderShouldShowCache = shouldShow;
  return shouldShow;
}

async function setPinReminderPending() {
  await chrome.storage.local.set({
    [PIN_REMINDER_PENDING_KEY]: true,
    [PIN_REMINDER_SHOWN_KEY]: false
  });
  pinReminderShouldShowCache = true;
}

async function markPinReminderShown() {
  await chrome.storage.local.set({
    [PIN_REMINDER_SHOWN_KEY]: true,
    [PIN_REMINDER_PENDING_KEY]: false
  });
  pinReminderShouldShowCache = false;
}

async function getLiveSplitSnapshot(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const container = document.getElementById('wiki-split-container');
        const iframe = document.getElementById('wiki-split-iframe');
        return {
          hasSplit: Boolean(container),
          wikipediaUrl: iframe?.src || null
        };
      }
    });

    const snapshot = result?.[0]?.result;
    return {
      hasSplit: snapshot?.hasSplit === true,
      wikipediaUrl: typeof snapshot?.wikipediaUrl === 'string' ? snapshot.wikipediaUrl : null
    };
  } catch {
    return { hasSplit: false, wikipediaUrl: null };
  }
}

function enqueueContextMenuMutation(reason, mutation) {
  contextMenuMutationQueue = contextMenuMutationQueue
    .then(() => mutation())
    .catch((error) => {
      console.warn('[Grokipedia Split] Context menu queue error:', reason, error);
    });

  return contextMenuMutationQueue;
}

function removeAllContextMenus(eventBase, details = {}) {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => {
      if (chrome.runtime.lastError) {
        console.warn('[Grokipedia Split] Context menu removeAll failed:', eventBase, details, chrome.runtime.lastError.message);
      }

      resolve();
    });
  });
}

function createContextMenuItem(config, reason) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(config, () => {
      if (chrome.runtime.lastError) {
        console.warn('[Grokipedia Split] Context menu create failed:', reason, config.id, chrome.runtime.lastError.message);
      }

      resolve();
    });
  });
}

function createContextMenus(reason = 'unspecified') {
  return enqueueContextMenuMutation(`create:${reason}`, async () => {
    await removeAllContextMenus('contextMenu:removeAll', { reason });

    await createContextMenuItem({
      id: CONTEXT_MENU_WIKI,
      title: 'Open in Grokipedia Split View',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['https://en.wikipedia.org/wiki/*']
    }, reason);

    await createContextMenuItem({
      id: CONTEXT_MENU_GROKI,
      title: 'Open in Wikipedia Split View',
      contexts: ['page', 'frame'],
      documentUrlPatterns: ['https://grokipedia.com/page/*']
    }, reason);
  });
}

async function initContextMenu(reason = 'unspecified') {
  const syncResult = await chrome.storage.sync.get(['contextMenuEnabled']);
  const enabled = syncResult.contextMenuEnabled !== false;

  if (!enabled) {
    await enqueueContextMenuMutation(`init:${reason}:disabled`, () => {
      return removeAllContextMenus('contextMenu:init:removeAll', {
        reason,
        removeReason: 'disabled'
      });
    });
    return;
  }

  await createContextMenus(`init:${reason}:default`);
}

async function updateContextMenu(enabled, reason = 'unspecified') {
  if (!enabled) {
    await enqueueContextMenuMutation(`update:${reason}:disabled`, () => {
      return removeAllContextMenus('contextMenu:update:removeAll', {
        reason,
        removeReason: 'disabled'
      });
    });
    return;
  }

  await createContextMenus(`update:${reason}:default`);
}

async function isSyncAcrossPanesEnabled() {
  const result = await chrome.storage.sync.get(['syncArticlesAcrossPanes']);
  return result.syncArticlesAcrossPanes === true;
}

function clearPendingNavigation(tabId) {
  const pending = pendingNavigations.get(tabId);
  if (!pending) {
    return;
  }

  clearTimeout(pending.timeoutId);
  pendingNavigations.delete(tabId);
}

function setPendingNavigation(tabId, wikipediaUrl) {
  clearPendingNavigation(tabId);

  const timeoutId = setTimeout(() => {
    if (!pendingNavigations.has(tabId)) {
      return;
    }

    clearPendingNavigation(tabId);
    void showToastInTab(tabId, showErrorToast, [
      'Navigation Timeout',
      'Grokipedia took too long to load.'
    ]);
    void exitSplitView(tabId);
  }, NAVIGATION_TIMEOUT_MS);

  pendingNavigations.set(tabId, {
    wikipediaUrl,
    timeoutId
  });
}

async function showToastInTab(tabId, toastFunc, args = []) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: toastFunc,
      args
    });
    return true;
  } catch (error) {
    console.log('[Grokipedia Split] Toast injection failed:', error);
    return false;
  }
}

async function removeSplitUiInTab(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: removeInjectedSplitUi
    });
  } catch (error) {
    console.log('[Grokipedia Split] Could not remove split UI from tab:', tabId, error);
  }
}

async function activateSplitView(tabId, wikipediaUrl = null, wikipediaFrameUrl = wikipediaUrl) {
  const currentState = await getSplitState();
  const existingSplitTabId = currentState.splitTabId;

  if (existingSplitTabId && existingSplitTabId !== tabId) {
    clearPendingNavigation(existingSplitTabId);
    await removeSplitUiInTab(existingSplitTabId);
  }

  await setSplitState(tabId, wikipediaUrl, wikipediaFrameUrl);
  console.log('[Grokipedia Split] Entered split view on tab', tabId);
}

async function exitSplitView(expectedTabId = null) {
  const state = await getSplitState();
  const splitTabId = state.splitTabId;

  if (expectedTabId !== null && splitTabId !== expectedTabId) {
    return;
  }

  if (splitTabId) {
    clearPendingNavigation(splitTabId);
  }

  await clearSplitState();
  clearWikipediaTargetCacheForTab(splitTabId);
  console.log('[Grokipedia Split] Exited split view');
}

async function reconcileSplitState() {
  const state = await getSplitState();
  const splitTabId = state.splitTabId;

  if (splitTabId) {
    try {
      const tab = await chrome.tabs.get(splitTabId);
      const tabUrl = parseUrl(tab.url || '');

      if (!tabUrl || !isGrokipediaHost(tabUrl.hostname)) {
        await clearSplitState();
      } else if (tab.status === 'complete') {
        try {
          const domCheck = await chrome.scripting.executeScript({
            target: { tabId: splitTabId },
            func: () => Boolean(document.getElementById('wiki-split-container'))
          });

          if (!domCheck[0]?.result) {
            await clearSplitState();
          }
        } catch (error) {
          console.log('[Grokipedia Split] Could not verify split DOM during reconcile; keeping state:', error);
        }
      }
    } catch (error) {
      const message = typeof error?.message === 'string' ? error.message : '';
      if (message.includes('No tab with id')) {
        await clearSplitState();
      } else {
        console.log('[Grokipedia Split] Could not reconcile split tab; keeping state:', error);
      }
    }
  }

  await initContextMenu('reconcileSplitState');
}

async function checkUrlExists(candidateUrl) {
  try {
    const headResponse = await fetch(candidateUrl, {
      method: 'HEAD',
      cache: 'no-store'
    });

    if (headResponse.ok) {
      return true;
    }

    if (![403, 405, 501].includes(headResponse.status)) {
      return false;
    }
  } catch {
    // Fall through to GET fallback.
  }

  try {
    const getResponse = await fetch(candidateUrl, {
      method: 'GET',
      cache: 'no-store'
    });

    return getResponse.ok;
  } catch {
    return false;
  }
}

function buildGrokipediaCandidateUrls(wikipediaArticle) {
  const exactArticle = wikipediaArticle.replace(/\s+/g, '_').trim();
  if (!exactArticle) {
    return [];
  }

  const normalizedArticle = exactArticle.toLowerCase().replace(/[()]/g, '');
  const articleCandidates = [exactArticle];

  if (normalizedArticle && normalizedArticle !== exactArticle) {
    articleCandidates.push(normalizedArticle);
  }

  return [...new Set(articleCandidates)].map((article) => {
    return `https://grokipedia.com/page/${encodePathPreservingSlashes(article)}`;
  });
}

async function resolveGrokipediaUrl(wikipediaArticle) {
  const candidateUrls = buildGrokipediaCandidateUrls(wikipediaArticle);

  for (const candidateUrl of candidateUrls) {
    const exists = await checkUrlExists(candidateUrl);
    if (exists) {
      return candidateUrl;
    }
  }

  return null;
}

function buildWikipediaSearchUrl(article) {
  const searchQuery = article.replace(/_/g, ' ').trim();
  if (!searchQuery) {
    return null;
  }

  return `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(searchQuery)}&title=Special%3ASearch&fulltext=1`;
}

async function resolveWikipediaTitleViaApi(titleCandidate) {
  const normalizedTitle = titleCandidate.replace(/\s+/g, ' ').trim();
  if (!normalizedTitle) {
    return { found: false, title: null, hadError: false };
  }

  const apiUrl = `https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1&titles=${encodeURIComponent(normalizedTitle)}&origin=*`;

  try {
    const response = await fetch(apiUrl, {
      method: 'GET',
      cache: 'no-store'
    });

    if (!response.ok) {
      return { found: false, title: null, hadError: true };
    }

    const data = await response.json();
    const pages = data?.query?.pages;
    if (!pages || typeof pages !== 'object') {
      return { found: false, title: null, hadError: true };
    }

    const existingPage = Object.values(pages).find((page) => {
      if (!page || typeof page !== 'object') {
        return false;
      }

      return !Object.prototype.hasOwnProperty.call(page, 'missing');
    });

    if (!existingPage) {
      return { found: false, title: null, hadError: false };
    }

    const resolvedTitle = typeof existingPage.title === 'string'
      ? existingPage.title.replace(/\s+/g, ' ').trim()
      : '';
    if (!resolvedTitle) {
      return { found: false, title: null, hadError: true };
    }

    return { found: true, title: resolvedTitle, hadError: false };
  } catch {
    return { found: false, title: null, hadError: true };
  }
}

function buildWikipediaArticleUrlFromTitle(title) {
  const normalizedTitle = title.replace(/\s+/g, '_').trim();
  if (!normalizedTitle) {
    return null;
  }

  return `https://en.wikipedia.org/wiki/${encodePathPreservingSlashes(normalizedTitle)}`;
}

async function getGrokipediaArticleTitleFromTab(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const candidates = [];
        const h1 = document.querySelector('h1');
        if (h1?.textContent) {
          candidates.push(h1.textContent);
        }

        const ogTitle = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
        if (ogTitle) {
          candidates.push(ogTitle);
        }

        const twitterTitle = document.querySelector('meta[name="twitter:title"]')?.getAttribute('content');
        if (twitterTitle) {
          candidates.push(twitterTitle);
        }

        if (document.title) {
          candidates.push(document.title);
        }

        for (const rawCandidate of candidates) {
          const compact = rawCandidate.replace(/\s+/g, ' ').trim();
          if (!compact) {
            continue;
          }

          const cleaned = compact
            .replace(/\s*[-|]\s*Grokipedia.*$/i, '')
            .replace(/\s*[-|]\s*Wikipedia Split View.*$/i, '')
            .trim();

          if (cleaned) {
            return cleaned;
          }
        }

        return '';
      }
    });

    const title = typeof result?.[0]?.result === 'string' ? result[0].result.trim() : '';
    return title;
  } catch {
    return '';
  }
}

async function resolveWikipediaTargetFromGrokipediaArticle(article, tabId = null) {
  const normalizedArticle = article.replace(/\s+/g, '_').trim();
  if (!normalizedArticle) {
    return { url: null, articleUrl: null, usedSearchFallback: false };
  }

  const fallbackSlugTitle = toWikipediaTitleCase(normalizedArticle).replace(/_/g, ' ');
  const grokipediaTitle = typeof tabId === 'number'
    ? await getGrokipediaArticleTitleFromTab(tabId)
    : '';

  const titleCandidates = [grokipediaTitle, fallbackSlugTitle]
    .filter((value) => Boolean(value))
    .filter((value, index, array) => {
      return array.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index;
    });

  let hadApiError = false;
  for (const candidate of titleCandidates) {
    const result = await resolveWikipediaTitleViaApi(candidate);
    if (result.hadError) {
      hadApiError = true;
      continue;
    }

    if (!result.found || !result.title) {
      continue;
    }

    const wikipediaUrl = buildWikipediaArticleUrlFromTitle(result.title);
    if (wikipediaUrl) {
      return { url: wikipediaUrl, articleUrl: wikipediaUrl, usedSearchFallback: false };
    }
  }

  const fallbackArticleUrl = buildWikipediaArticleUrlFromTitle(grokipediaTitle || fallbackSlugTitle);
  if (hadApiError) {
    if (fallbackArticleUrl) {
      return { url: fallbackArticleUrl, articleUrl: fallbackArticleUrl, usedSearchFallback: false };
    }
  }

  const wikipediaSearchUrl = buildWikipediaSearchUrl(grokipediaTitle || fallbackSlugTitle);
  if (!wikipediaSearchUrl) {
    return { url: null, articleUrl: fallbackArticleUrl, usedSearchFallback: false };
  }

  return {
    url: wikipediaSearchUrl,
    articleUrl: fallbackArticleUrl,
    usedSearchFallback: true
  };
}

async function resolveWikipediaTargetForTab(article, tabId = null) {
  if (typeof tabId !== 'number') {
    return resolveWikipediaTargetFromGrokipediaArticle(article, null);
  }

  const articleKey = getArticleCacheKey(article);
  if (!articleKey) {
    return { url: null, articleUrl: null, usedSearchFallback: false };
  }

  const cachedEntry = wikipediaTargetCacheByTab.get(tabId);
  if (
    cachedEntry &&
    cachedEntry.articleKey === articleKey &&
    Date.now() - cachedEntry.cachedAt < WIKIPEDIA_TARGET_CACHE_TTL_MS
  ) {
    return cachedEntry.target;
  }

  const inflightKey = `${tabId}:${articleKey}`;
  const inflightRequest = wikipediaTargetInflightByKey.get(inflightKey);
  if (inflightRequest) {
    return inflightRequest;
  }

  const request = resolveWikipediaTargetFromGrokipediaArticle(article, tabId)
    .then((target) => {
      wikipediaTargetCacheByTab.set(tabId, {
        articleKey,
        target,
        cachedAt: Date.now()
      });
      return target;
    })
    .finally(() => {
      wikipediaTargetInflightByKey.delete(inflightKey);
    });

  wikipediaTargetInflightByKey.set(inflightKey, request);
  return request;
}

function buildGrokipediaSearchUrl(wikipediaArticle) {
  const searchQuery = wikipediaArticle.replace(/_/g, ' ').trim();
  if (!searchQuery) {
    return null;
  }

  return `https://grokipedia.com/search?q=${encodeURIComponent(searchQuery)}`;
}

async function ensureWikipediaFrameUrl(tabId, wikipediaUrl, stateWikipediaUrl = null) {
  let frameUrlToPersist = typeof wikipediaUrl === 'string' && wikipediaUrl ? wikipediaUrl : null;
  let stateUrlToPersist = stateWikipediaUrl || getWikipediaArticleUrl(frameUrlToPersist || '');
  if (!stateUrlToPersist) {
    const currentState = await getSplitState();
    if (currentState.splitTabId === tabId) {
      stateUrlToPersist = currentState.wikipediaUrl || null;
    }
  }

  if (!frameUrlToPersist) {
    const currentState = await getSplitState();
    if (currentState.splitTabId === tabId) {
      frameUrlToPersist = currentState.wikipediaFrameUrl || currentState.wikipediaUrl || null;
    }
  }

  await setSplitState(tabId, stateUrlToPersist || null, frameUrlToPersist || null);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: recreateWikiFrame,
      args: [wikipediaUrl]
    });
    return true;
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectWikipediaFrame,
        args: [wikipediaUrl]
      });
      return true;
    } catch (error) {
      console.log('[Grokipedia Split] Failed to update Wikipedia pane:', error);
      return false;
    }
  }
}

async function navigateSplitTabToGrokipedia(tabId, grokipediaUrl, wikipediaUrl) {
  if (pendingNavigations.has(tabId)) {
    await showToastInTab(tabId, showErrorToast, [
      'Still Loading',
      'Split view navigation is already in progress.'
    ]);
    return false;
  }

  setPendingNavigation(tabId, wikipediaUrl);

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (url) => {
        window.location.href = url;
      },
      args: [grokipediaUrl]
    });
    return true;
  } catch (error) {
    clearPendingNavigation(tabId);
    await exitSplitView(tabId);
    await showToastInTab(tabId, showErrorToast, [
      'Navigation Error',
      'Could not open the Grokipedia page.'
    ]);
    console.log('[Grokipedia Split] Failed to sync to Grokipedia:', error);
    return false;
  }
}

async function syncFromWikipediaSource(tabId, wikipediaUrl, forceSyncToGrokipedia = false) {
  const targetUrl = parseUrl(wikipediaUrl);
  if (
    !targetUrl ||
    targetUrl.protocol !== 'https:' ||
    !isWikipediaHost(targetUrl.hostname)
  ) {
    return false;
  }

  const canSyncToGrokipedia = isWikipediaArticlePath(targetUrl.pathname);
  const syncAcrossPanes = forceSyncToGrokipedia || (await isSyncAcrossPanesEnabled());

  if (!syncAcrossPanes || !canSyncToGrokipedia) {
    return ensureWikipediaFrameUrl(tabId, targetUrl.href);
  }

  const wikipediaArticle = safeDecodeURIComponent(targetUrl.pathname.slice('/wiki/'.length));
  const grokipediaUrl = await resolveGrokipediaUrl(wikipediaArticle);

  if (!grokipediaUrl) {
    const grokipediaSearchUrl = buildGrokipediaSearchUrl(wikipediaArticle);
    if (!grokipediaSearchUrl) {
      const frameUpdated = await ensureWikipediaFrameUrl(tabId, targetUrl.href);
      await showToastInTab(tabId, showErrorToast, [
        'Article Not Found',
        "Grokipedia doesn't have this article yet."
      ]);
      return frameUpdated;
    }

    await showToastInTab(tabId, showErrorToast, [
      'Grokipedia Exact Match Not Found',
      'Opening Grokipedia search results.'
    ]);

    await setSplitState(tabId, targetUrl.href);
    return navigateSplitTabToGrokipedia(tabId, grokipediaSearchUrl, targetUrl.href);
  }

  await setSplitState(tabId, targetUrl.href);
  return navigateSplitTabToGrokipedia(tabId, grokipediaUrl, targetUrl.href);
}

async function syncFromGrokipediaSource(tabId, grokipediaUrl) {
  const sourceUrl = parseUrl(grokipediaUrl);
  if (
    !sourceUrl ||
    sourceUrl.protocol !== 'https:' ||
    !isGrokipediaHost(sourceUrl.hostname) ||
    !isGrokipediaArticlePath(sourceUrl.pathname)
  ) {
    return false;
  }

  const article = safeDecodeURIComponent(sourceUrl.pathname.slice('/page/'.length));
  const target = await resolveWikipediaTargetForTab(article, tabId);
  const wikipediaUrl = target.url;
  if (!wikipediaUrl) {
    await showToastInTab(tabId, showErrorToast, [
      'Invalid Article',
      'Could not build a Wikipedia URL for this page.'
    ]);
    return false;
  }

  if (target.usedSearchFallback) {
    await showToastInTab(tabId, showErrorToast, [
      'Wikipedia Exact Match Not Found',
      'Opening Wikipedia search results.'
    ]);
  }

  const wikipediaArticleUrl = target.articleUrl || getWikipediaArticleUrl(wikipediaUrl);
  return ensureWikipediaFrameUrl(tabId, wikipediaUrl, wikipediaArticleUrl);
}

async function handleWikiLinkClicked(message, sender) {
  const senderTabId = sender.tab?.id;
  if (typeof senderTabId !== 'number' || sender.frameId <= 0) {
    return false;
  }

  const senderUrl = parseUrl(sender.url || '');
  if (!senderUrl || senderUrl.protocol !== 'https:' || !isWikipediaHost(senderUrl.hostname)) {
    return false;
  }

  const targetUrl = parseUrl(message.url);
  if (!targetUrl || targetUrl.protocol !== 'https:' || !isWikipediaHost(targetUrl.hostname)) {
    return false;
  }

  const splitState = await getSplitState();
  if (splitState.splitTabId !== senderTabId) {
    return false;
  }

  return syncFromWikipediaSource(senderTabId, targetUrl.href, false);
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.status === 'complete' && tab?.url) {
    await maybeShowPinReminder(tab);
  }

  if (changeInfo.url) {
    clearWikipediaTargetCacheForTab(tabId);
    const changedUrl = parseUrl(changeInfo.url);

    if (changedUrl) {
      const splitState = await getSplitState();
      if (splitState.splitTabId === tabId) {
        if (!isGrokipediaHost(changedUrl.hostname)) {
          await exitSplitView(tabId);
          return;
        }
      }
    }
  }

  const pending = pendingNavigations.get(tabId);
  if (pending && changeInfo.status === 'complete' && tab?.url) {
    const loadedUrl = parseUrl(tab.url);
    if (!loadedUrl || !isGrokipediaHost(loadedUrl.hostname)) {
      return;
    }

    clearPendingNavigation(tabId);

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: injectWikipediaFrame,
        args: [pending.wikipediaUrl]
      });
    } catch (error) {
      console.log('[Grokipedia Split] Failed to inject split frame:', error);
      await exitSplitView(tabId);
    }

    return;
  }

  if (changeInfo.status !== 'complete' || !tab?.url) {
    return;
  }

  const loadedUrl = parseUrl(tab.url);
  if (!loadedUrl || !isGrokipediaHost(loadedUrl.hostname)) {
    return;
  }

  const splitState = await getSplitState();
  if (
    splitState.splitTabId !== tabId ||
    (!splitState.wikipediaUrl && !splitState.wikipediaFrameUrl)
  ) {
    return;
  }

  const syncAcrossPanes = await isSyncAcrossPanesEnabled();
  let desiredFrameWikipediaUrl = splitState.wikipediaFrameUrl || splitState.wikipediaUrl;
  let desiredStateWikipediaUrl =
    splitState.wikipediaUrl || getWikipediaArticleUrl(desiredFrameWikipediaUrl || '');

  if (syncAcrossPanes && isGrokipediaArticlePath(loadedUrl.pathname)) {
    const article = safeDecodeURIComponent(loadedUrl.pathname.slice('/page/'.length));
    const target = await resolveWikipediaTargetForTab(article, tabId);
    if (target.url) {
      desiredFrameWikipediaUrl = target.url;
    }

    if (target.articleUrl) {
      desiredStateWikipediaUrl = target.articleUrl;
    } else {
      const derivedArticleUrl = getWikipediaArticleUrl(target.url);
      if (derivedArticleUrl) {
        desiredStateWikipediaUrl = derivedArticleUrl;
      }
    }
  }

  if (!desiredFrameWikipediaUrl) {
    return;
  }

  if (
    !urlsEquivalent(desiredStateWikipediaUrl, splitState.wikipediaUrl) ||
    !urlsEquivalent(desiredFrameWikipediaUrl, splitState.wikipediaFrameUrl)
  ) {
    await setSplitState(tabId, desiredStateWikipediaUrl || null, desiredFrameWikipediaUrl || null);
  }

  try {
    const domCheck = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const container = document.getElementById('wiki-split-container');
        const iframe = document.getElementById('wiki-split-iframe');
        return {
          hasSplit: Boolean(container),
          wikipediaUrl: iframe?.src || null
        };
      }
    });

    const splitSnapshot = domCheck?.[0]?.result;
    if (splitSnapshot?.hasSplit) {
      if (!urlsEquivalent(splitSnapshot.wikipediaUrl, desiredFrameWikipediaUrl)) {
        await chrome.scripting.executeScript({
          target: { tabId },
          func: recreateWikiFrame,
          args: [desiredFrameWikipediaUrl]
        });
      }
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: injectWikipediaFrame,
      args: [desiredFrameWikipediaUrl]
    });
  } catch (error) {
    console.log('[Grokipedia Split] Failed to restore split frame after refresh:', error);
    await exitSplitView(tabId);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearPendingNavigation(tabId);
  clearWikipediaTargetCacheForTab(tabId);

  void (async () => {
    const splitState = await getSplitState();
    if (splitState.splitTabId === tabId) {
      await exitSplitView(tabId);
    }
  })();
});

async function handleSplitContextMenuClick(info, tab, liveSnapshot = null) {
  if (!tab || typeof tab.id !== 'number') {
    return;
  }

  const splitState = await getSplitState();
  const snapshot = liveSnapshot || await getLiveSplitSnapshot(tab.id);
  const splitActive = snapshot.hasSplit || splitState.splitTabId === tab.id;
  if (!splitActive) {
    return;
  }

  const snapshotFrameWikipediaUrl = snapshot.wikipediaUrl || '';
  const stateFrameWikipediaUrl = splitState.wikipediaFrameUrl || splitState.wikipediaUrl || '';
  const nextFrameWikipediaUrl = snapshotFrameWikipediaUrl || stateFrameWikipediaUrl || null;

  const frameWikipediaArticleUrl = getWikipediaArticleUrl(nextFrameWikipediaUrl || '');
  const stateWikipediaUrl = splitState.wikipediaUrl || '';
  const stateWikipediaArticleUrl = getWikipediaArticleUrl(stateWikipediaUrl);
  const nextStateWikipediaUrl = frameWikipediaArticleUrl || stateWikipediaArticleUrl || null;
  if (
    splitState.splitTabId !== tab.id ||
    !urlsEquivalent(nextStateWikipediaUrl, splitState.wikipediaUrl) ||
    !urlsEquivalent(nextFrameWikipediaUrl, splitState.wikipediaFrameUrl)
  ) {
    await setSplitState(tab.id, nextStateWikipediaUrl, nextFrameWikipediaUrl);
  }

  const sourceUrl = parseUrl(info.frameUrl || info.pageUrl || tab.url || '');
  const tabUrl = parseUrl(tab.url || '');

  if (info.menuItemId === CONTEXT_MENU_WIKI) {
    const wikipediaSource =
      sourceUrl &&
      sourceUrl.protocol === 'https:' &&
      isWikipediaHost(sourceUrl.hostname) &&
      isWikipediaArticlePath(sourceUrl.pathname)
        ? sourceUrl
        : parseUrl(nextStateWikipediaUrl || nextFrameWikipediaUrl || '');

    if (!wikipediaSource) {
      return;
    }

    await syncFromWikipediaSource(tab.id, wikipediaSource.href, true);
    return;
  }

  if (info.menuItemId === CONTEXT_MENU_GROKI) {
    const grokipediaSource =
      sourceUrl &&
      sourceUrl.protocol === 'https:' &&
      isGrokipediaHost(sourceUrl.hostname) &&
      isGrokipediaArticlePath(sourceUrl.pathname)
        ? sourceUrl
        : tabUrl;

    if (
      !grokipediaSource ||
      grokipediaSource.protocol !== 'https:' ||
      !isGrokipediaHost(grokipediaSource.hostname) ||
      !isGrokipediaArticlePath(grokipediaSource.pathname)
    ) {
      return;
    }

    await syncFromGrokipediaSource(tab.id, grokipediaSource.href);
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab) {
    return;
  }

  if (
    info.menuItemId !== CONTEXT_MENU_WIKI &&
    info.menuItemId !== CONTEXT_MENU_GROKI
  ) {
    return;
  }

  void (async () => {
    const splitState = await getSplitState();
    const liveSnapshot = await getLiveSplitSnapshot(tab.id);
    if (splitState.splitTabId === tab.id || liveSnapshot.hasSplit) {
      await handleSplitContextMenuClick(info, tab, liveSnapshot);
      return;
    }

    await handleSplitView(tab);
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const messageType = message?.type;

  if (messageType === 'updateContextMenu') {
    void updateContextMenu(message.enabled === true, 'runtimeMessage:updateContextMenu');
    return;
  }

  if (messageType === 'splitClosed') {
    const senderTabId = sender.tab?.id;
    if (typeof senderTabId !== 'number') {
      sendResponse({ ok: false });
      return;
    }

    void (async () => {
      await exitSplitView(senderTabId);
      sendResponse({ ok: true });
    })();

    return true;
  }

  if (messageType === 'querySplitStatus') {
    const senderTabId = sender.tab?.id;
    const isTopFrame = sender.frameId === 0;

    void (async () => {
      if (typeof senderTabId !== 'number' || !isTopFrame) {
        sendResponse({ active: false });
        return;
      }

      const splitState = await getSplitState();
      sendResponse({ active: splitState.splitTabId === senderTabId });
    })();

    return true;
  }

  if (messageType === 'queryWikiIframeIntercept') {
    const senderTabId = sender.tab?.id;
    const senderUrl = parseUrl(sender.url || '');
    const isIframe = sender.frameId > 0;

    void (async () => {
      if (
        typeof senderTabId !== 'number' ||
        !isIframe ||
        !senderUrl ||
        senderUrl.protocol !== 'https:' ||
        !isWikipediaHost(senderUrl.hostname)
      ) {
        sendResponse({ allow: false });
        return;
      }

      const splitState = await getSplitState();
      sendResponse({ allow: splitState.splitTabId === senderTabId });
    })();

    return true;
  }

  if (messageType === 'wikiLinkClicked') {
    void (async () => {
      const ok = await handleWikiLinkClicked(message, sender);
      sendResponse({ ok });
    })();

    return true;
  }
});

chrome.action.onClicked.addListener((tab) => {
  void handleSplitView(tab);
});

async function maybeShowPinReminder(tab) {
  if (!tab?.url || typeof tab.id !== 'number') {
    return;
  }

  const tabUrl = parseUrl(tab.url);
  if (!tabUrl || !['http:', 'https:'].includes(tabUrl.protocol)) {
    return;
  }

  if (!isWikipediaHost(tabUrl.hostname) && !isGrokipediaHost(tabUrl.hostname)) {
    return;
  }

  let shouldShow = false;
  try {
    shouldShow = await shouldShowPinReminder();
  } catch {
    return;
  }

  if (!shouldShow) {
    return;
  }

  const iconUrl = chrome.runtime.getURL('icon48.png');
  const shown = await showToastInTab(tab.id, showPinReminderToast, [iconUrl]);
  if (!shown) {
    return;
  }

  try {
    await markPinReminderShown();
  } catch {
    // Ignore storage write failures; reminder may show again later.
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    await initContextMenu('onInstalled');

    if (details.reason !== 'install') {
      return;
    }

    await setPinReminderPending();

    try {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
      });

      if (activeTab) {
        await maybeShowPinReminder(activeTab);
      }
    } catch {
      // If this fails (e.g. startup races), reminder will show on next eligible page load.
    }
  })();
});

async function handleSplitView(tab) {
  if (!tab?.url || typeof tab.id !== 'number') {
    return;
  }

  if (pendingNavigations.has(tab.id)) {
    await showToastInTab(tab.id, showErrorToast, [
      'Still Loading',
      'Split view navigation is already in progress.'
    ]);
    return;
  }

  const tabUrl = parseUrl(tab.url);
  if (!tabUrl) {
    return;
  }

  const splitState = await getSplitState();
  if (splitState.splitTabId === tab.id) {
    try {
      const domCheck = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => Boolean(document.getElementById('wiki-split-container'))
      });

      if (domCheck[0]?.result) {
        await showToastInTab(tab.id, showErrorToast, [
          'Already Open',
          'Split view is already active on this page.'
        ]);
        return;
      }
    } catch {
      // If DOM checks fail, continue and clear stale state.
    }

    await exitSplitView(tab.id);
  }

  if (
    tabUrl.protocol === 'https:' &&
    isWikipediaHost(tabUrl.hostname) &&
    isWikipediaArticlePath(tabUrl.pathname)
  ) {
    const wikipediaArticle = safeDecodeURIComponent(tabUrl.pathname.slice('/wiki/'.length));

    await showToastInTab(tab.id, showLoadingToast);
    const grokipediaUrl = await resolveGrokipediaUrl(wikipediaArticle);
    await showToastInTab(tab.id, removeToast);

    if (!grokipediaUrl) {
      const grokipediaSearchUrl = buildGrokipediaSearchUrl(wikipediaArticle);
      if (!grokipediaSearchUrl) {
        await showToastInTab(tab.id, showErrorToast, [
          'Article Not Found',
          "This Wikipedia article isn't available on Grokipedia yet."
        ]);
        return;
      }

      await showToastInTab(tab.id, showErrorToast, [
        'Grokipedia Exact Match Not Found',
        'Opening Grokipedia search results.'
      ]);

      await activateSplitView(tab.id, tabUrl.href);
      await navigateSplitTabToGrokipedia(tab.id, grokipediaSearchUrl, tabUrl.href);
      return;
    }

    await activateSplitView(tab.id, tabUrl.href);
    await navigateSplitTabToGrokipedia(tab.id, grokipediaUrl, tabUrl.href);
    return;
  }

  if (
    tabUrl.protocol === 'https:' &&
    isGrokipediaHost(tabUrl.hostname) &&
    isGrokipediaArticlePath(tabUrl.pathname)
  ) {
    const article = safeDecodeURIComponent(tabUrl.pathname.slice('/page/'.length));
    const target = await resolveWikipediaTargetForTab(article, tab.id);
    const wikipediaUrl = target.url;
    const wikipediaArticleUrl = target.articleUrl || getWikipediaArticleUrl(wikipediaUrl);

    if (!wikipediaUrl) {
      await showToastInTab(tab.id, showErrorToast, [
        'Invalid Article',
        'Could not build a Wikipedia URL for this page.'
      ]);
      return;
    }

    if (target.usedSearchFallback) {
      await showToastInTab(tab.id, showErrorToast, [
        'Wikipedia Exact Match Not Found',
        'Opening Wikipedia search results.'
      ]);
    }

    await activateSplitView(tab.id, wikipediaArticleUrl || wikipediaUrl, wikipediaUrl);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectWikipediaFrame,
        args: [wikipediaUrl]
      });
    } catch (error) {
      await exitSplitView(tab.id);
      await showToastInTab(tab.id, showErrorToast, [
        'Split View Error',
        'Could not inject the Wikipedia split frame.'
      ]);
      console.log('[Grokipedia Split] Direct injection failed:', error);
    }

    return;
  }

  await showToastInTab(tab.id, showErrorToast, [
    'Wrong Page',
    'Navigate to a Wikipedia or Grokipedia article first.'
  ]);
}

function showLoadingToast() {
  document.getElementById('grokipedia-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'grokipedia-toast';
  const animationStyle = document.createElement('style');
  animationStyle.textContent = '@keyframes grok-spin { to { transform: rotate(360deg); } }';

  const svgNs = 'http://www.w3.org/2000/svg';
  const spinner = document.createElementNS(svgNs, 'svg');
  spinner.setAttribute('width', '18');
  spinner.setAttribute('height', '18');
  spinner.setAttribute('viewBox', '0 0 24 24');
  spinner.style.animation = 'grok-spin 1s linear infinite';

  const circle = document.createElementNS(svgNs, 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '10');
  circle.setAttribute('stroke', '#666');
  circle.setAttribute('stroke-width', '3');
  circle.setAttribute('fill', 'none');

  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute('d', 'M12 2a10 10 0 0 1 10 10');
  path.setAttribute('stroke', 'white');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke-linecap', 'round');

  spinner.appendChild(circle);
  spinner.appendChild(path);

  const label = document.createElement('span');
  label.textContent = 'Checking Grokipedia...';

  toast.appendChild(animationStyle);
  toast.appendChild(spinner);
  toast.appendChild(label);
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #333;
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    display: flex;
    align-items: center;
    gap: 10px;
  `;

  const root = document.body || document.documentElement;
  root.appendChild(toast);
}

function showErrorToast(title, message) {
  document.getElementById('grokipedia-toast')?.remove();

  const toast = document.createElement('div');
  toast.id = 'grokipedia-toast';
  const titleLine = document.createElement('div');
  titleLine.style.cssText = 'font-weight: 500; margin-bottom: 4px;';
  titleLine.textContent = title;

  const messageLine = document.createElement('div');
  messageLine.style.cssText = 'color: #ccc; font-size: 13px;';
  messageLine.textContent = message;

  toast.appendChild(titleLine);
  toast.appendChild(messageLine);
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    background: #333;
    color: white;
    padding: 16px 24px;
    border-radius: 8px;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    max-width: 300px;
    cursor: pointer;
  `;
  toast.onclick = () => toast.remove();

  const root = document.body || document.documentElement;
  root.appendChild(toast);

  setTimeout(() => toast.remove(), 4000);
}

function showPinReminderToast(iconUrl) {
  const existing = document.getElementById('grokipedia-pin-reminder');
  if (existing) {
    return;
  }

  const card = document.createElement('div');
  card.id = 'grokipedia-pin-reminder';
  card.style.cssText = `
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 1000000;
    width: 330px;
    background: #111827;
    color: #f9fafb;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 10px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.35);
    font-family: system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    padding: 12px 12px 10px;
  `;

  const row = document.createElement('div');
  row.style.cssText = 'display: flex; gap: 10px; align-items: flex-start;';

  const icon = document.createElement('img');
  icon.src = iconUrl;
  icon.alt = 'Grokipedia icon';
  icon.style.cssText = 'width: 24px; height: 24px; border-radius: 4px; flex-shrink: 0; margin-top: 1px;';

  const textWrap = document.createElement('div');
  textWrap.style.cssText = 'flex: 1;';

  const title = document.createElement('div');
  title.textContent = 'Tip: Pin this extension';
  title.style.cssText = 'font-weight: 600; margin-bottom: 4px;';

  const body = document.createElement('div');
  body.textContent = 'Click the puzzle icon in the toolbar, then pin Grokipedia + Wikipedia Split View for one-click access.';
  body.style.cssText = 'color: #d1d5db;';

  const close = document.createElement('button');
  close.textContent = 'x';
  close.style.cssText = `
    border: none;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    font-size: 20px;
    line-height: 1;
    padding: 0;
    width: 20px;
    height: 20px;
    margin-top: -2px;
  `;
  close.addEventListener('click', () => card.remove());

  textWrap.appendChild(title);
  textWrap.appendChild(body);
  row.appendChild(icon);
  row.appendChild(textWrap);
  row.appendChild(close);
  card.appendChild(row);

  const root = document.body || document.documentElement;
  root.appendChild(card);

  setTimeout(() => card.remove(), 10000);
}

function removeToast() {
  document.getElementById('grokipedia-toast')?.remove();
}

function recreateWikiFrame(newUrl) {
  const container = document.getElementById('wiki-split-container');
  if (!container) {
    return;
  }

  const oldIframe = document.getElementById('wiki-split-iframe');
  oldIframe?.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'wiki-split-iframe';
  iframe.src = newUrl;
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    border: none;
  `;

  const header = container.firstElementChild;
  if (!header) {
    return;
  }
  header.insertAdjacentElement('afterend', iframe);

  const backLink = container.querySelector('a');
  if (backLink) {
    backLink.href = newUrl;
  }
}

function injectWikipediaFrame(wikipediaUrl) {
  if (document.getElementById('wiki-split-container')) {
    return;
  }

  document.body.classList.add('wiki-split-active');

  const style = document.createElement('style');
  style.id = 'wiki-split-styles';
  style.textContent = `
    body.wiki-split-active main,
    body.wiki-split-active article,
    body.wiki-split-active [role="main"] {
      max-width: 100% !important;
      width: 100% !important;
      margin-left: 0 !important;
      padding-left: 1rem !important;
    }
  `;
  document.head.appendChild(style);

  const container = document.createElement('div');
  container.id = 'wiki-split-container';
  container.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 50%;
    height: 100vh;
    z-index: 999999;
    background: white;
    display: flex;
    flex-direction: column;
    box-shadow: 2px 0 10px rgba(0,0,0,0.3);
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    padding: 8px 12px;
    background: #f5f5f5;
    border-bottom: 1px solid #ddd;
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-family: system-ui, sans-serif;
    font-size: 13px;
    flex-shrink: 0;
  `;
  const backLink = document.createElement('a');
  backLink.href = wikipediaUrl;
  backLink.textContent = '<- Back to Wikipedia article (close Grokipedia)';
  backLink.style.cssText = 'color: #0066cc; text-decoration: none;';

  const closeButton = document.createElement('button');
  closeButton.id = 'wiki-split-close';
  closeButton.textContent = 'Close Wikipedia';
  closeButton.style.cssText = `
      border: none;
      background: #e0e0e0;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    `;
  header.appendChild(backLink);
  header.appendChild(closeButton);

  const iframe = document.createElement('iframe');
  iframe.id = 'wiki-split-iframe';
  iframe.src = wikipediaUrl;
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    border: none;
  `;

  const dragHandle = document.createElement('div');
  dragHandle.id = 'wiki-split-drag';
  dragHandle.style.cssText = `
    position: absolute;
    right: -4px;
    top: 0;
    width: 8px;
    height: 100%;
    cursor: ew-resize;
    background: linear-gradient(to right, transparent, rgba(0,0,0,0.1), transparent);
    z-index: 1000000;
  `;

  const dragOverlay = document.createElement('div');
  dragOverlay.id = 'wiki-split-overlay';
  dragOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 1000001;
    cursor: ew-resize;
    display: none;
  `;

  container.appendChild(header);
  container.appendChild(iframe);
  container.appendChild(dragHandle);
  document.body.appendChild(container);
  document.body.appendChild(dragOverlay);

  closeButton.addEventListener('click', () => {
    container.remove();
    dragOverlay.remove();
    document.getElementById('wiki-split-styles')?.remove();
    document.body.classList.remove('wiki-split-active');
    document.body.style.marginLeft = '';
    document.body.style.width = '';
    document.body.style.position = '';
    document.body.style.overflowX = '';
    document.body.style.removeProperty('--wiki-split-width');

    chrome.runtime.sendMessage({ type: 'splitClosed' });
  });

  let isDragging = false;

  dragHandle.addEventListener('mousedown', (event) => {
    isDragging = true;
    dragOverlay.style.display = 'block';
    event.preventDefault();
  });

  document.addEventListener('mousemove', (event) => {
    if (!isDragging) {
      return;
    }

    const newWidth = event.clientX;
    const widthPercent = (newWidth / window.innerWidth) * 100;

    if (widthPercent > 20 && widthPercent < 80) {
      container.style.width = `${widthPercent}%`;
      document.body.style.setProperty('--wiki-split-width', `${widthPercent}%`);
    }
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) {
      return;
    }

    isDragging = false;
    dragOverlay.style.display = 'none';
  });
}

function removeInjectedSplitUi() {
  const container = document.getElementById('wiki-split-container');
  const overlay = document.getElementById('wiki-split-overlay');

  container?.remove();
  overlay?.remove();
  document.getElementById('wiki-split-styles')?.remove();

  if (document.body) {
    document.body.classList.remove('wiki-split-active');
    document.body.style.marginLeft = '';
    document.body.style.width = '';
    document.body.style.position = '';
    document.body.style.overflowX = '';
    document.body.style.removeProperty('--wiki-split-width');
  }
}

void (async () => {
  await reconcileSplitState();
})().catch((error) => {
  console.error('[Grokipedia Split] Startup reconciliation failed:', error);
});
console.log('[Grokipedia Split] Extension loaded');
