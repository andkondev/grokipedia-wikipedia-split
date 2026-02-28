// Runs at document_start - before page renders
// Check if we should be in split mode
chrome.storage.local.get(['splitModeActive'], (result) => {
  if (result.splitModeActive) {
    // Clear immediately so it doesn't affect future visits
    chrome.storage.local.set({ splitModeActive: false });
    
    document.documentElement.classList.add('wiki-split-pending');
    
    // Apply to body as soon as it exists
    const observer = new MutationObserver(() => {
      if (document.body) {
        document.body.classList.add('wiki-split-active');
        observer.disconnect();
      }
    });
    
    observer.observe(document.documentElement, { childList: true });
    
    // Also try immediately in case body already exists
    if (document.body) {
      document.body.classList.add('wiki-split-active');
    }
  }
});
