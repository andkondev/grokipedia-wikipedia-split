// Load saved settings
chrome.storage.sync.get(['contextMenuEnabled'], (result) => {
  // Default to true if not set
  const enabled = result.contextMenuEnabled !== false;
  document.getElementById('contextMenu').checked = enabled;
});

// Save settings on change
document.getElementById('contextMenu').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  
  chrome.storage.sync.set({ contextMenuEnabled: enabled }, () => {
    // Notify background script to update context menu
    chrome.runtime.sendMessage({ type: 'updateContextMenu', enabled: enabled });
    
    // Show saved indicator
    const saved = document.getElementById('saved');
    saved.classList.add('show');
    setTimeout(() => saved.classList.remove('show'), 2000);
  });
});
