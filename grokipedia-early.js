function applySplitLayoutClass() {
  if (document.body) {
    document.body.classList.add('wiki-split-active');
    return;
  }

  const observer = new MutationObserver(() => {
    if (!document.body) {
      return;
    }

    document.body.classList.add('wiki-split-active');
    observer.disconnect();
  });

  observer.observe(document.documentElement, { childList: true });
}

if (window.self === window.top) {
  chrome.runtime.sendMessage({ type: 'querySplitStatus' }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }

    if (response?.active) {
      applySplitLayoutClass();
    }
  });
}
