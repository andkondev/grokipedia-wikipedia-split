const contextMenuCheckbox = document.getElementById('contextMenu');
const syncArticlesCheckbox = document.getElementById('syncArticles');
const savedIndicator = document.getElementById('saved');

function showSaved() {
  savedIndicator.classList.add('show');
  setTimeout(() => savedIndicator.classList.remove('show'), 2000);
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
    showSaved();
  });
});

syncArticlesCheckbox.addEventListener('change', (event) => {
  const enabled = event.target.checked;

  chrome.storage.sync.set({ syncArticlesAcrossPanes: enabled }, () => {
    showSaved();
  });
});
