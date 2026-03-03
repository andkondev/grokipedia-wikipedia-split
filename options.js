const contextMenuCheckbox = document.getElementById('contextMenu');
const syncArticlesCheckbox = document.getElementById('syncArticles');
const savedContextMenuIndicator = document.getElementById('savedContextMenu');
const savedSyncArticlesIndicator = document.getElementById('savedSyncArticles');

function showSaved(indicator) {
  if (!indicator) {
    return;
  }

  indicator.classList.add('show');

  if (indicator._hideTimerId) {
    clearTimeout(indicator._hideTimerId);
  }

  indicator._hideTimerId = setTimeout(() => {
    indicator.classList.remove('show');
    indicator._hideTimerId = null;
  }, 1800);
}

chrome.storage.sync.get(['contextMenuEnabled', 'syncArticlesAcrossPanes'], (result) => {
  const contextMenuEnabled = result.contextMenuEnabled !== false;
  const syncArticlesAcrossPanes = result.syncArticlesAcrossPanes === true;

  contextMenuCheckbox.checked = contextMenuEnabled;
  syncArticlesCheckbox.checked = syncArticlesAcrossPanes;
});

contextMenuCheckbox.addEventListener('change', (event) => {
  const enabled = event.target.checked;

  chrome.storage.sync.set({ contextMenuEnabled: enabled }, () => {
    chrome.runtime.sendMessage({ type: 'updateContextMenu', enabled });
    showSaved(savedContextMenuIndicator);
  });
});

syncArticlesCheckbox.addEventListener('change', (event) => {
  const enabled = event.target.checked;

  chrome.storage.sync.set({ syncArticlesAcrossPanes: enabled }, () => {
    showSaved(savedSyncArticlesIndicator);
  });
});
