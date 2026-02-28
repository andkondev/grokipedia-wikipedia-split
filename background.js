// Track active listener and in-progress state
let activeTabListener = null;
let navigationInProgress = false;

// Context menu IDs
const CONTEXT_MENU_WIKI = 'grokipedia-split-view-wiki';
const CONTEXT_MENU_GROKI = 'grokipedia-split-view-groki';

// Helper function to convert article name to title case for Wikipedia
// Handles: barros_blancos -> Barros_Blancos
// Keeps lowercase: of, the, and, in, on, at, to, for, with (except first word)
function toWikipediaTitleCase(article) {
  const lowercaseWords = ['of', 'the', 'and', 'in', 'on', 'at', 'to', 'for', 'with', 'a', 'an'];
  
  return article.split('_').map((word, index) => {
    // Check for roman numerals (keep uppercase)
    if (/^[ivxlcdm]+$/i.test(word)) {
      return word.toUpperCase();
    }
    // First word always capitalized, others check lowercase list
    if (index === 0 || !lowercaseWords.includes(word.toLowerCase())) {
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    }
    return word.toLowerCase();
  }).join('_');
}

// Initialize context menu based on settings
function initContextMenu() {
  chrome.storage.sync.get(['contextMenuEnabled'], (result) => {
    // Default to true if not set
    const enabled = result.contextMenuEnabled !== false;
    
    // Also check if we're currently in split view
    chrome.storage.local.get(['splitTabId'], (localResult) => {
      // Only show context menus if enabled AND not in split view
      if (enabled && !localResult.splitTabId) {
        createContextMenus();
      } else {
        chrome.contextMenus.removeAll();
      }
    });
  });
}

// Create context menus
function createContextMenus() {
  chrome.contextMenus.removeAll(() => {
    // Context menu for Wikipedia pages
    chrome.contextMenus.create({
      id: CONTEXT_MENU_WIKI,
      title: 'Open in Grokipedia Split View',
      contexts: ['page'],
      documentUrlPatterns: ['https://*.wikipedia.org/wiki/*']
    });
    
    // Context menu for Grokipedia pages
    chrome.contextMenus.create({
      id: CONTEXT_MENU_GROKI,
      title: 'Open in Wikipedia Split View',
      contexts: ['page'],
      documentUrlPatterns: ['https://grokipedia.com/page/*']
    });
  });
}

// Update context menu visibility based on settings
function updateContextMenu(enabled) {
  if (enabled) {
    // Check if in split view before creating
    chrome.storage.local.get(['splitTabId'], (result) => {
      if (!result.splitTabId) {
        createContextMenus();
      }
    });
  } else {
    chrome.contextMenus.removeAll();
  }
}

// Enter split view - hide context menus
function enterSplitView(tabId, wikipediaUrl = null) {
  const data = { 
    splitModeActive: true,
    splitTabId: tabId
  };
  if (wikipediaUrl) {
    data.wikipediaUrl = wikipediaUrl;
  }
  chrome.storage.local.set(data);
  // Hide context menus while in split view
  chrome.contextMenus.removeAll();
  console.log('[Grokipedia Split] Entered split view, context menus hidden');
}

// Exit split view - restore context menus
function exitSplitView() {
  chrome.storage.local.set({ 
    splitModeActive: false, 
    splitTabId: null,
    wikipediaUrl: null
  });
  // Restore context menus
  initContextMenu();
  console.log('[Grokipedia Split] Exited split view, context menus restored');
}

// Initialize on extension load
// Clear any stale split view state from previous sessions
chrome.storage.local.set({ 
  splitModeActive: false, 
  splitTabId: null,
  wikipediaUrl: null
}).then(() => {
  initContextMenu();
});
console.log('[Grokipedia Split] Extension loaded, state cleared');

// Watch for tab URL changes to detect navigation away from split view
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    chrome.storage.local.get(['splitTabId'], (result) => {
      if (result.splitTabId === tabId) {
        // This is our split view tab - check if still on Grokipedia
        if (!changeInfo.url.includes('grokipedia.com')) {
          console.log('[Grokipedia Split] Split tab navigated away from Grokipedia, clearing state');
          exitSplitView();
        }
      }
    });
  }
});

// Watch for tab closure
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(['splitTabId'], (result) => {
    if (result.splitTabId === tabId) {
      console.log('[Grokipedia Split] Split tab closed, clearing state');
      exitSplitView();
    }
  });
});

// Handle context menu clicks
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_WIKI || info.menuItemId === CONTEXT_MENU_GROKI) {
    // Double-check we're not in split view (shouldn't happen since menus are hidden)
    const result = await chrome.storage.local.get(['splitTabId']);
    
    if (result.splitTabId === tab.id) {
      console.log('[Grokipedia Split] Context menu clicked but already in split view');
      return;
    }
    
    // Trigger the split view action
    handleSplitView(tab);
  }
});

// Handle messages from options page and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'updateContextMenu') {
    updateContextMenu(message.enabled);
  }
  
  if (message.type === 'splitClosed') {
    console.log('[Grokipedia Split] Received splitClosed message');
    exitSplitView();
  }
  
  if (message.type === 'wikiLinkClicked') {
    // Need to recreate iframe from extension context to bypass CSP
    chrome.storage.local.get(['splitTabId'], (result) => {
      if (result.splitTabId) {
        // Inject script to update iframe by recreating it
        chrome.scripting.executeScript({
          target: { tabId: result.splitTabId },
          func: recreateWikiFrame,
          args: [message.url]
        }).catch(err => console.log('[Grokipedia Split] Recreate error:', err));
      }
    });
  }
});

// Handle extension icon click
chrome.action.onClicked.addListener(async (tab) => {
  handleSplitView(tab);
});

// Main function to handle split view (used by both icon click and context menu)
async function handleSplitView(tab) {
  if (!tab.url) return;
  
  // Prevent clicks while navigation is in progress
  if (navigationInProgress) {
    console.log('[Grokipedia Split] Navigation already in progress, ignoring click');
    return;
  }
  
  // Check if already in split view on this tab
  const storageResult = await chrome.storage.local.get(['splitTabId']);
  if (storageResult.splitTabId === tab.id) {
    // Double-check by looking for the container element
    try {
      const domCheck = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => !!document.getElementById('wiki-split-container')
      });
      
      if (domCheck[0]?.result) {
        console.log('[Grokipedia Split] Already in split view on this tab');
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: showErrorToast,
          args: ['Already Open', 'Split view is already active on this page.']
        });
        return;
      } else {
        // Storage says split view, but DOM doesn't have it - clear stale state
        console.log('[Grokipedia Split] Stale split view state detected, clearing');
        exitSplitView();
      }
    } catch (e) {
      // Couldn't check DOM, clear stale state to be safe
      console.log('[Grokipedia Split] Could not verify split view state, clearing');
      exitSplitView();
    }
  }
  
  try {
    const url = new URL(tab.url);
    
    // Check if we're on Wikipedia
    if (url.hostname.includes('wikipedia.org') && url.pathname.startsWith('/wiki/')) {
      const article = url.pathname.replace('/wiki/', '');
      const wikipediaUrl = tab.url;
      
      navigationInProgress = true;
      
      // Show loading toast
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: showLoadingToast
      });
      
      // Try exact article name first
      const exactUrl = `https://grokipedia.com/page/${article}`;
      
      // Normalized version as fallback (lowercase, no parentheses)
      const normalizedArticle = article
        .toLowerCase()
        .replace(/\(/g, '')
        .replace(/\)/g, '');
      const normalizedUrl = `https://grokipedia.com/page/${normalizedArticle}`;
      
      console.log('[Grokipedia Split] Trying exact URL:', exactUrl);
      
      let grokipediaUrl = null;
      
      // Check if Grokipedia page exists
      try {
        // Try exact URL first
        let response = await fetch(exactUrl, { method: 'HEAD' });
        console.log('[Grokipedia Split] Exact URL response:', response.status);
        
        if (response.ok) {
          grokipediaUrl = exactUrl;
        } else if (normalizedArticle !== article) {
          // Try normalized URL as fallback
          console.log('[Grokipedia Split] Trying normalized URL:', normalizedUrl);
          response = await fetch(normalizedUrl, { method: 'HEAD' });
          console.log('[Grokipedia Split] Normalized URL response:', response.status);
          
          if (response.ok) {
            grokipediaUrl = normalizedUrl;
          }
        }
        
        // Remove loading toast
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: removeToast
        });
        
        if (!grokipediaUrl) {
          navigationInProgress = false;
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: showErrorToast,
            args: ['Article Not Found', "This Wikipedia article isn't available on Grokipedia yet."]
          });
          return;
        }
      } catch (e) {
        // Remove loading toast
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: removeToast
        });
        
        navigationInProgress = false;
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: showErrorToast,
          args: ['Connection Error', 'Could not connect to Grokipedia.']
        });
        return;
      }
      
      console.log('[Grokipedia Split] Using URL:', grokipediaUrl);
      
      // Enter split view mode (hides context menus)
      enterSplitView(tab.id, wikipediaUrl);
      
      // Remove any existing listener before adding new one
      if (activeTabListener) {
        chrome.tabs.onUpdated.removeListener(activeTabListener);
        activeTabListener = null;
      }
      
      // Create listener with closure over the specific tab and URLs
      const targetTabId = tab.id;
      const targetWikipediaUrl = wikipediaUrl;
      
      activeTabListener = function listener(tabId, changeInfo, updatedTab) {
        // Only act on our specific tab
        if (tabId !== targetTabId) return;
        
        // Verify we're actually on Grokipedia
        if (changeInfo.status === 'complete' && updatedTab.url && updatedTab.url.includes('grokipedia.com')) {
          console.log('[Grokipedia Split] Grokipedia loaded, injecting iframe');
          
          // Clean up listener
          chrome.tabs.onUpdated.removeListener(listener);
          activeTabListener = null;
          navigationInProgress = false;
          
          chrome.scripting.executeScript({
            target: { tabId: targetTabId },
            func: injectWikipediaFrame,
            args: [targetWikipediaUrl]
          });
        }
      };
      
      chrome.tabs.onUpdated.addListener(activeTabListener);
      
      // Navigate using content script (like clicking a link) to preserve history
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (url) => { window.location.href = url; },
        args: [grokipediaUrl]
      });
      
      return;
    }
    
    // Check if we're on Grokipedia
    if (url.hostname.includes('grokipedia.com') && url.pathname.startsWith('/page/')) {
      const article = url.pathname.replace('/page/', '');
      
      // Convert to Wikipedia title case (barros_blancos -> Barros_Blancos)
      const titleCaseArticle = toWikipediaTitleCase(article);
      const wikipediaUrl = `https://en.wikipedia.org/wiki/${titleCaseArticle}`;
      
      console.log('[Grokipedia Split] Grokipedia article:', article);
      console.log('[Grokipedia Split] Title case article:', titleCaseArticle);
      console.log('[Grokipedia Split] Wikipedia URL:', wikipediaUrl);
      
      // Enter split view mode (hides context menus)
      enterSplitView(tab.id, wikipediaUrl);
      
      // Inject Wikipedia frame directly (we're already on Grokipedia)
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: injectWikipediaFrame,
        args: [wikipediaUrl]
      });
      
      return;
    }
    
    // Not on Wikipedia or Grokipedia
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: showErrorToast,
      args: ['Wrong Page', 'Navigate to a Wikipedia or Grokipedia article first.']
    });
    
  } catch (e) {
    console.error('Error:', e);
    navigationInProgress = false;
  }
}

// Toast UI functions (injected into page)
function showLoadingToast() {
  // Remove any existing toast
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
  document.body.appendChild(toast);
}

function showErrorToast(title, message) {
  // Remove any existing toast
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
  document.body.appendChild(toast);
  
  // Auto-dismiss after 4 seconds
  setTimeout(() => toast.remove(), 4000);
}

function removeToast() {
  document.getElementById('grokipedia-toast')?.remove();
}

// Function to recreate the Wikipedia iframe (runs in Grokipedia page context via extension)
function recreateWikiFrame(newUrl) {
  const container = document.getElementById('wiki-split-container');
  if (!container) return;
  
  const oldIframe = document.getElementById('wiki-split-iframe');
  if (oldIframe) {
    oldIframe.remove();
  }
  
  // Create new iframe
  const iframe = document.createElement('iframe');
  iframe.id = 'wiki-split-iframe';
  iframe.src = newUrl;
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    border: none;
  `;
  
  // Insert after header (first child)
  const header = container.firstElementChild;
  header.insertAdjacentElement('afterend', iframe);
  
  // Update back link
  const backLink = container.querySelector('a');
  if (backLink) {
    backLink.href = newUrl;
  }
}

// Track when Wikipedia loads in any frame and inject click interceptor
chrome.webNavigation.onCompleted.addListener((details) => {
  console.log('[Grokipedia Split] webNavigation.onCompleted:', details.url, 'frameId:', details.frameId);
  
  // Only care about frames (not main page) on Wikipedia
  if (details.frameId === 0) {
    console.log('[Grokipedia Split] Skipping - main frame');
    return;
  }
  
  chrome.storage.local.get(['splitTabId'], (result) => {
    console.log('[Grokipedia Split] splitTabId:', result.splitTabId, 'details.tabId:', details.tabId);
    
    if (result.splitTabId === details.tabId) {
      console.log('[Grokipedia Split] Injecting into frame', details.frameId);
      // This is our split view tab, inject into the Wikipedia iframe
      chrome.scripting.executeScript({
        target: { tabId: details.tabId, frameIds: [details.frameId] },
        func: injectClickInterceptor
      }).then(() => {
        console.log('[Grokipedia Split] Injection successful');
      }).catch(err => console.log('[Grokipedia Split] Inject error:', err));
    } else {
      console.log('[Grokipedia Split] Tab ID mismatch, skipping');
    }
  });
}, { url: [{ hostContains: 'wikipedia.org' }] });

// Function to inject into Wikipedia iframe
function injectClickInterceptor() {
  console.log('[Grokipedia Split] injectClickInterceptor() called, location:', window.location.href);
  
  // Prevent double-injection
  if (window.__wikiClickInterceptorInstalled) {
    console.log('[Grokipedia Split] Already installed, skipping');
    return;
  }
  window.__wikiClickInterceptorInstalled = true;
  
  console.log('[Grokipedia Split] Installing click handler...');
  
  document.addEventListener('click', (e) => {
    console.log('[Grokipedia Split] Click detected on:', e.target.tagName);
    
    const link = e.target.closest('a');
    if (!link) {
      console.log('[Grokipedia Split] No link found');
      return;
    }
    
    const href = link.getAttribute('href');
    if (!href) {
      console.log('[Grokipedia Split] No href');
      return;
    }
    
    let fullUrl;
    try {
      fullUrl = new URL(href, window.location.href).href;
    } catch {
      return;
    }
    
    console.log('[Grokipedia Split] Link clicked:', fullUrl);
    
    // Only intercept Wikipedia links
    if (!fullUrl.includes('wikipedia.org')) {
      e.preventDefault();
      window.open(fullUrl, '_blank');
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({
      type: 'wikiLinkClicked',
      url: fullUrl
    });
  }, true);
  
  console.log('[Grokipedia Split] Click handler installed');
}

// This function runs in the context of the Grokipedia page
function injectWikipediaFrame(wikipediaUrl) {
  // Prevent duplicates
  if (document.getElementById('wiki-split-container')) {
    return;
  }
  
  // Ensure body has the split class
  document.body.classList.add('wiki-split-active');
  
  // Inject additional CSS for content styling
  const style = document.createElement('style');
  style.id = 'wiki-split-styles';
  style.textContent = `
    /* Force main content to use full width of its container */
    main, article, [class*="content"], [class*="Content"], [class*="article"], [class*="Article"] {
      max-width: 100% !important;
      width: 100% !important;
      margin-left: 0 !important;
      padding-left: 1rem !important;
    }
  `;
  document.head.appendChild(style);
  
  // Create Wikipedia iframe container (LEFT side)
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
  
  // Create header with controls
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
    <a href="${wikipediaUrl}" style="color: #0066cc; text-decoration: none;">← Back to Wikipedia article</a>
    <button id="wiki-split-close" style="
      border: none;
      background: #e0e0e0;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    ">Close</button>
  `;
  
  // Create iframe
  const iframe = document.createElement('iframe');
  iframe.id = 'wiki-split-iframe';
  iframe.src = wikipediaUrl;
  iframe.style.cssText = `
    flex: 1;
    width: 100%;
    border: none;
  `;
  
  // Function to update iframe URL
  function updateIframeSrc(newUrl) {
    iframe.src = newUrl;
    // Update the back link too
    const backLink = container.querySelector('a');
    if (backLink) {
      backLink.href = newUrl;
    }
  }
  
  // Listen for messages to update iframe URL (from Wikipedia link clicks)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'updateWikiFrame' && message.url) {
      updateIframeSrc(message.url);
    }
  });
  
  // Create drag handle (on right edge of container)
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
  
  // Create overlay for capturing mouse during drag (hidden by default)
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
  
  // Assemble container
  container.appendChild(header);
  container.appendChild(iframe);
  container.appendChild(dragHandle);
  document.body.appendChild(container);
  document.body.appendChild(dragOverlay);
  
  // Close button handler
  document.getElementById('wiki-split-close').addEventListener('click', () => {
    container.remove();
    dragOverlay.remove();
    document.getElementById('wiki-split-styles')?.remove();
    document.body.classList.remove('wiki-split-active');
    document.body.style.marginLeft = '';
    document.body.style.width = '';
    document.body.style.position = '';
    document.body.style.overflowX = '';
    
    // Notify background to clear the flag
    chrome.runtime.sendMessage({ type: 'splitClosed' });
  });
  
  // Drag to resize
  let isDragging = false;
  
  dragHandle.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragOverlay.style.display = 'block';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    
    const newWidth = e.clientX;
    const widthPercent = (newWidth / window.innerWidth) * 100;
    
    if (widthPercent > 20 && widthPercent < 80) {
      container.style.width = widthPercent + '%';
      // Update CSS variable so !important rules still work
      document.body.style.setProperty('--wiki-split-width', widthPercent + '%');
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      dragOverlay.style.display = 'none';
    }
  });
}
