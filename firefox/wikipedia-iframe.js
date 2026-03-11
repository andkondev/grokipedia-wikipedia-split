function isWikipediaHost(hostname) {
  return hostname === 'en.wikipedia.org';
}

function installClickHandler() {
  if (window.__wikiSplitClickHandlerInstalled) {
    return;
  }
  window.__wikiSplitClickHandlerInstalled = true;

  document.addEventListener(
    'click',
    (event) => {
      const link = event.target.closest('a');
      if (!link) {
        return;
      }

      const href = link.getAttribute('href');
      if (!href) {
        return;
      }

      let fullUrl;
      try {
        fullUrl = new URL(href, window.location.href);
      } catch {
        return;
      }

      if (!['http:', 'https:'].includes(fullUrl.protocol)) {
        return;
      }

      if (!isWikipediaHost(fullUrl.hostname)) {
        event.preventDefault();
        window.open(fullUrl.href, '_blank', 'noopener');
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      chrome.runtime.sendMessage({
        type: 'wikiLinkClicked',
        url: fullUrl.href
      });
    },
    true
  );
}

if (window.self !== window.top) {
  chrome.runtime.sendMessage({ type: 'queryWikiIframeIntercept' }, (response) => {
    if (chrome.runtime.lastError) {
      return;
    }

    if (response?.allow) {
      installClickHandler();
    }
  });
}
