const SPLIT_WIDTH_STORAGE_KEY = 'grokipediaSplitWidthPercent';
const DEFAULT_SPLIT_WIDTH_PERCENT = 50;
const MIN_SPLIT_WIDTH_PERCENT = 20;
const MAX_SPLIT_WIDTH_PERCENT = 80;

function normalizeSplitWidthPercent(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_SPLIT_WIDTH_PERCENT;
  }

  return Math.max(MIN_SPLIT_WIDTH_PERCENT, Math.min(MAX_SPLIT_WIDTH_PERCENT, numeric));
}

function readSavedSplitWidthPercent() {
  try {
    const value = window.localStorage.getItem(SPLIT_WIDTH_STORAGE_KEY);
    if (value === null) {
      return null;
    }

    return normalizeSplitWidthPercent(value);
  } catch {
    return null;
  }
}

function applySavedSplitWidth() {
  if (!document.body) {
    return;
  }

  const splitWidthPercent = readSavedSplitWidthPercent();
  if (splitWidthPercent === null) {
    return;
  }

  document.body.style.setProperty('--wiki-split-width', `${splitWidthPercent}%`);
}

function applySplitLayoutClass() {
  if (document.body) {
    applySavedSplitWidth();
    document.body.classList.add('wiki-split-active');
    return;
  }

  const observer = new MutationObserver(() => {
    if (!document.body) {
      return;
    }

    applySavedSplitWidth();
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
