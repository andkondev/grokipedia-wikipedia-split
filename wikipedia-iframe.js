// Only run if we're inside an iframe
if (window.self !== window.top) {
  document.addEventListener('click', (e) => {
    // Find closest anchor tag
    const link = e.target.closest('a');
    if (!link) return;
    
    const href = link.getAttribute('href');
    if (!href) return;
    
    // Build full URL
    let fullUrl;
    try {
      fullUrl = new URL(href, window.location.href).href;
    } catch {
      return; // Invalid URL, let it fail naturally
    }
    
    // Only intercept Wikipedia links
    if (!fullUrl.includes('wikipedia.org')) {
      // External link - open in new tab
      e.preventDefault();
      window.open(fullUrl, '_blank');
      return;
    }
    
    // Prevent default navigation
    e.preventDefault();
    
    // Send message to background script to update iframe
    chrome.runtime.sendMessage({
      type: 'wikiLinkClicked',
      url: fullUrl
    });
  }, true); // Use capture to get it before other handlers
}
