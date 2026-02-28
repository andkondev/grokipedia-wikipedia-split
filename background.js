const CONTEXT_MENU_WIKI = 'grokipedia-split-view-wiki';
const CONTEXT_MENU_GROKI = 'grokipedia-split-view-groki';
const NAVIGATION_TIMEOUT_MS = 15000;
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

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isWikipediaHost(hostname) {
  return hostname === 'wikipedia.org' || hostname.endsWith('.wikipedia.org');
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

      if (isAllLower) {
        return lowerWord.charAt(0).toUpperCase() + lowerWord.slice(1);
      }

      return word;
    })
    .join('_');
}

async function getSplitState() {
  return chrome.storage.local.get(['splitTabId', 'wikipediaUrl']);
}

async function setSplitState(tabId, wikipediaUrl = null) {
  await chrome.storage.local.set({
    splitTabId: tabId,
    wikipediaUrl
  });
}

async function clearSplitState() {
  await chrome.storage.local.set({
    splitTabId: null,
    wikipediaUrl: null
  });
}

function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_WIKI,
      title: 'Open in Grokipedia Split View',
      contexts: ['page'],
      documentUrlPatterns: ['https://*.wikipedia.org/wiki/*']
    });

    chrome.contextMenus.create({
      id: CONTEXT_MENU_GROKI,
      title: 'Open in Wikipedia Split View',
      contexts: ['page'],
      documentUrlPatterns: ['https://grokipedia.com/page/*']
    });
  });
}

async function initContextMenu() {
  const syncResult = await chrome.storage.sync.get(['contextMenuEnabled']);
  const enabled = syncResult.contextMenuEnabled !== false;
  const localResult = await getSplitState();

  if (enabled && !localResult.splitTabId) {
    createContextMenus();
    return;
  }

  chrome.contextMenus.removeAll();
}

async function updateContextMenu(enabled) {
  if (!enabled) {
    chrome.contextMenus.removeAll();
    return;
  }

  const localResult = await getSplitState();
  if (!localResult.splitTabId) {
    createContextMenus();
  }
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

async function activateSplitView(tabId, wikipediaUrl = null) {
  const currentState = await getSplitState();
  const existingSplitTabId = currentState.splitTabId;

  if (existingSplitTabId && existingSplitTabId !== tabId) {
    clearPendingNavigation(existingSplitTabId);
    await removeSplitUiInTab(existingSplitTabId);
  }

  await setSplitState(tabId, wikipediaUrl);
  chrome.contextMenus.removeAll();
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
  await initContextMenu();
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
        } catch {
          await clearSplitState();
        }
      }
    } catch {
      await clearSplitState();
    }
  }

  await initContextMenu();
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

function buildWikipediaUrlFromArticle(article) {
  const normalizedArticle = article.replace(/\s+/g, '_').trim();
  if (!normalizedArticle) {
    return null;
  }

  const titleCaseArticle = toWikipediaTitleCase(normalizedArticle);
  return `https://en.wikipedia.org/wiki/${encodePathPreservingSlashes(titleCaseArticle)}`;
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

  try {
    await chrome.scripting.executeScript({
      target: { tabId: senderTabId },
      func: recreateWikiFrame,
      args: [targetUrl.href]
    });
    return true;
  } catch (error) {
    console.log('[Grokipedia Split] Failed to recreate iframe:', error);
    return false;
  }
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.url) {
    const changedUrl = parseUrl(changeInfo.url);

    if (changedUrl) {
      const splitState = await getSplitState();
      if (splitState.splitTabId === tabId && !isGrokipediaHost(changedUrl.hostname)) {
        await exitSplitView(tabId);
        return;
      }
    }
  }

  const pending = pendingNavigations.get(tabId);
  if (!pending || changeInfo.status !== 'complete' || !tab?.url) {
    // Continue so active split tabs can recover after refresh.
  } else {
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
  }

  if (changeInfo.status !== 'complete' || !tab?.url) {
    return;
  }

  const loadedUrl = parseUrl(tab.url);
  if (!loadedUrl || !isGrokipediaHost(loadedUrl.hostname)) {
    return;
  }

  const splitState = await getSplitState();
  if (splitState.splitTabId !== tabId || !splitState.wikipediaUrl) {
    return;
  }

  try {
    const domCheck = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => Boolean(document.getElementById('wiki-split-container'))
    });

    if (domCheck[0]?.result) {
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId },
      func: injectWikipediaFrame,
      args: [splitState.wikipediaUrl]
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

  void (async () => {
    const splitState = await getSplitState();
    if (splitState.splitTabId === tabId) {
      await exitSplitView(tabId);
    }
  })();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (
    info.menuItemId !== CONTEXT_MENU_WIKI &&
    info.menuItemId !== CONTEXT_MENU_GROKI
  ) {
    return;
  }

  if (!tab) {
    return;
  }

  void handleSplitView(tab);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const messageType = message?.type;

  if (messageType === 'updateContextMenu') {
    void updateContextMenu(message.enabled === true);
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
      await showToastInTab(tab.id, showErrorToast, [
        'Article Not Found',
        "This Wikipedia article isn't available on Grokipedia yet."
      ]);
      return;
    }

    await activateSplitView(tab.id, tabUrl.href);
    setPendingNavigation(tab.id, tabUrl.href);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (url) => {
          window.location.href = url;
        },
        args: [grokipediaUrl]
      });
    } catch (error) {
      clearPendingNavigation(tab.id);
      await exitSplitView(tab.id);
      await showToastInTab(tab.id, showErrorToast, [
        'Navigation Error',
        'Could not open the Grokipedia page.'
      ]);
      console.log('[Grokipedia Split] Navigation failed:', error);
    }

    return;
  }

  if (
    tabUrl.protocol === 'https:' &&
    isGrokipediaHost(tabUrl.hostname) &&
    isGrokipediaArticlePath(tabUrl.pathname)
  ) {
    const article = safeDecodeURIComponent(tabUrl.pathname.slice('/page/'.length));
    const wikipediaUrl = buildWikipediaUrlFromArticle(article);

    if (!wikipediaUrl) {
      await showToastInTab(tab.id, showErrorToast, [
        'Invalid Article',
        'Could not build a Wikipedia URL for this page.'
      ]);
      return;
    }

    await activateSplitView(tab.id, wikipediaUrl);

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
  toast.innerHTML = `
    <style>
      @keyframes grok-spin { to { transform: rotate(360deg); } }
    </style>
    <svg width="18" height="18" viewBox="0 0 24 24" style="animation: grok-spin 1s linear infinite;">
      <circle cx="12" cy="12" r="10" stroke="#666" stroke-width="3" fill="none"/>
      <path d="M12 2a10 10 0 0 1 10 10" stroke="white" stroke-width="3" fill="none" stroke-linecap="round"/>
    </svg>
    <span>Checking Grokipedia...</span>
  `;
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
  toast.innerHTML = `
    <div style="font-weight: 500; margin-bottom: 4px;">${title}</div>
    <div style="color: #ccc; font-size: 13px;">${message}</div>
  `;
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
    main, article, [class*="content"], [class*="Content"], [class*="article"], [class*="Article"] {
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
  header.innerHTML = `
    <a href="${wikipediaUrl}" style="color: #0066cc; text-decoration: none;"><- Back to Wikipedia article</a>
    <button id="wiki-split-close" style="
      border: none;
      background: #e0e0e0;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    ">Close</button>
  `;

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

  const closeButton = document.getElementById('wiki-split-close');
  if (closeButton) {
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
  }

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

reconcileSplitState().catch((error) => {
  console.error('[Grokipedia Split] Startup reconciliation failed:', error);
});
console.log('[Grokipedia Split] Extension loaded');
