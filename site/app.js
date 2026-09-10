'use strict';

(() => {
  const languageButton = document.querySelector('#language');
  const copyButton = document.querySelector('#copy-install');
  const feedback = document.querySelector('#copy-feedback');
  const code = document.querySelector('#install-code');
  const dialog = document.querySelector('#screenshot-dialog');
  const fullImage = document.querySelector('#screenshot-full');
  const caption = document.querySelector('#screenshot-caption');
  const previousButton = document.querySelector('#previous-screenshot');
  const nextButton = document.querySelector('#next-screenshot');
  const zoomButton = document.querySelector('#toggle-zoom');
  const position = document.querySelector('#screenshot-position');
  const lightboxScroll = dialog.querySelector('.lightbox-scroll');
  const screenshotFeedback = document.querySelector('#screenshot-feedback') || (() => {
    const node = document.createElement('p');
    node.id = 'screenshot-feedback';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    dialog.insertBefore(node, lightboxScroll);
    return node;
  })();
  let language = 'zh';
  let copyState = '';
  let copying = false;
  let openedImage = null;
  let opener = null;
  let screenshotIndex = -1;
  let screenshotState = '';
  let imageGeneration = 0;
  let pendingImage = null;
  const screenshotButtons = [...document.querySelectorAll('[data-screenshot]')];
  const gallery = [];
  const galleryIndex = new Map();
  screenshotButtons.forEach(button => {
    const image = button.querySelector('img');
    if (!image?.getAttribute('src')) return;
    const source = new URL(image.getAttribute('src'), document.baseURI).href;
    if (galleryIndex.has(source)) return;
    galleryIndex.set(source, gallery.length);
    gallery.push({source, image});
  });

  const translatedText = [...document.querySelectorAll('[data-en]')].map(node => ({node, zh: node.textContent, en: node.dataset.en}));
  const translatedAlt = [...document.querySelectorAll('[data-alt-en]')].map(node => ({node, zh: node.alt, en: node.dataset.altEn}));
  const translatedAria = [...document.querySelectorAll('[data-aria-en]')].map(node => ({node, zh: node.getAttribute('aria-label'), en: node.dataset.ariaEn}));
  const feedbackText = {
    zh: {success: '已复制安装命令。', failed: '未能复制，请选中命令后手动复制。'},
    en: {success: 'Installation command copied.', failed: 'Copy failed. Select the command and copy it manually.'},
  };
  const screenshotText = {
    zh: {loading: '正在加载截图…', failed: '这张截图暂时无法加载。请尝试其他截图，或关闭后重新打开。', original: '原始大小', fit: '适应宽度', previous: '上一张截图', next: '下一张截图', position: '第 {current} 张，共 {total} 张'},
    en: {loading: 'Loading screenshot…', failed: 'This screenshot could not load. Try another screenshot, or close and reopen it.', original: 'Original size', fit: 'Fit to width', previous: 'Previous screenshot', next: 'Next screenshot', position: 'Screenshot {current} of {total}'},
  };

  function updateScreenshotControls() {
    const text = screenshotText[language];
    screenshotFeedback.textContent = text[screenshotState] || '';
    screenshotFeedback.hidden = !screenshotFeedback.textContent;
    screenshotFeedback.classList.toggle('is-error', screenshotState === 'failed');
    dialog.dataset.imageState = screenshotState;
    lightboxScroll.setAttribute('aria-busy', String(screenshotState === 'loading'));
    if (openedImage) { fullImage.alt = openedImage.alt; caption.textContent = openedImage.alt; }
    if (position) {
      position.textContent = screenshotIndex < 0 ? '' : `${screenshotIndex + 1} / ${gallery.length}`;
      if (screenshotIndex < 0) position.removeAttribute('aria-label');
      else position.setAttribute('aria-label', text.position.replace('{current}', String(screenshotIndex + 1)).replace('{total}', String(gallery.length)));
    }
    if (previousButton) { previousButton.disabled = gallery.length < 2; previousButton.setAttribute('aria-label', text.previous); }
    if (nextButton) { nextButton.disabled = gallery.length < 2; nextButton.setAttribute('aria-label', text.next); }
    if (zoomButton) {
      const zoomed = dialog.classList.contains('is-zoomed');
      const label = zoomed ? text.fit : text.original;
      (zoomButton.querySelector('[data-zoom-label]') || zoomButton).textContent = label;
      zoomButton.setAttribute('aria-pressed', String(zoomed));
      zoomButton.setAttribute('aria-label', label);
      zoomButton.disabled = screenshotState !== 'ready';
    }
  }

  function updateCopyFeedback() {
    feedback.textContent = feedbackText[language][copyState] || '';
    feedback.classList.toggle('is-error', copyState === 'failed');
  }

  function setLanguage(next) {
    language = next === 'en' ? 'en' : 'zh';
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.title = language === 'en' ? 'DSH SuperTerminal — Say what you need. Let your terminal work.' : 'DSH SuperTerminal — 说出目标，让终端去完成。';
    translatedText.forEach(item => { item.node.textContent = item[language]; });
    translatedAlt.forEach(item => { item.node.alt = item[language]; });
    translatedAria.forEach(item => { item.node.setAttribute('aria-label', item[language]); });
    languageButton.textContent = language === 'en' ? '中文' : 'EN';
    languageButton.setAttribute('aria-label', language === 'en' ? '切换到中文' : 'Switch to English');
    updateScreenshotControls();
    updateCopyFeedback();
    try { localStorage.setItem('superterminal.site.language', language); } catch { /* Language switching also works without storage. */ }
  }
  languageButton.addEventListener('click', () => setLanguage(language === 'en' ? 'zh' : 'en'));
  try { if (localStorage.getItem('superterminal.site.language') === 'en') setLanguage('en'); } catch { /* Keep the readable default. */ }

  copyButton.addEventListener('click', async () => {
    if (copying) return;
    copying = true;
    copyButton.disabled = true;
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(code.textContent.trim());
      copyState = 'success';
    } catch {
      copyState = 'failed';
      const range = document.createRange();
      range.selectNodeContents(code);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      code.parentElement.focus({preventScroll: true});
    } finally {
      copying = false;
      copyButton.disabled = false;
      updateCopyFeedback();
    }
  });

  document.querySelectorAll('[data-tour-tabs]').forEach(tablist => {
    const tabs = [...tablist.querySelectorAll('button[data-tour]')];
    const panels = new Map(tabs.map(tab => [tab, document.getElementById(tab.getAttribute('aria-controls'))]));
    function selectTab(tab, focus = false) {
      if (!panels.get(tab)) return;
      tabs.forEach(item => {
        const selected = item === tab;
        item.setAttribute('aria-selected', String(selected));
        item.tabIndex = selected ? 0 : -1;
        const panel = panels.get(item);
        if (panel) { panel.hidden = !selected; panel.setAttribute('aria-labelledby', item.id); }
      });
      if (focus) { tab.focus({preventScroll: true}); tab.scrollIntoView({block: 'nearest', inline: 'nearest'}); }
    }
    const initial = tabs.find(tab => tab.getAttribute('aria-selected') === 'true') || tabs.find(tab => tab.dataset.tour === 'workspace') || tabs[0];
    if (initial) selectTab(initial);
    tabs.forEach(tab => tab.addEventListener('click', () => selectTab(tab)));
    tablist.addEventListener('keydown', event => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const tab = event.target.closest('button[data-tour]');
      const current = tabs.indexOf(tab);
      if (current < 0 || !tabs.length) return;
      let next;
      if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next], true);
    });
  });

  function showScreenshot(index, image = null) {
    if (!gallery.length) return;
    screenshotIndex = (index + gallery.length) % gallery.length;
    const item = gallery[screenshotIndex];
    openedImage = image || item.image;
    const current = ++imageGeneration;
    if (pendingImage) { pendingImage.onload = null; pendingImage.onerror = null; }
    screenshotState = 'loading';
    fullImage.hidden = true;
    fullImage.removeAttribute('src');
    dialog.classList.remove('is-zoomed');
    lightboxScroll.scrollTo(0, 0);
    updateScreenshotControls();
    const loading = new Image();
    pendingImage = loading;
    loading.onload = () => {
      if (current !== imageGeneration || !dialog.open) return;
      pendingImage = null;
      screenshotState = 'ready';
      fullImage.src = item.source;
      fullImage.hidden = false;
      updateScreenshotControls();
    };
    loading.onerror = () => {
      if (current !== imageGeneration || !dialog.open) return;
      pendingImage = null;
      screenshotState = 'failed';
      updateScreenshotControls();
    };
    loading.src = item.source;
  }

  function openScreenshot(button, returnFocus = button) {
    const image = button.querySelector('img');
    if (!image?.getAttribute('src')) return;
    const source = new URL(image.getAttribute('src'), document.baseURI).href;
    const index = galleryIndex.get(source);
    if (index === undefined) return;
    opener = returnFocus;
    dialog.showModal();
    document.body.classList.add('dialog-open');
    showScreenshot(index, image);
    document.querySelector('#close-screenshot').focus();
  }
  screenshotButtons.forEach(button => button.addEventListener('click', () => openScreenshot(button)));
  document.querySelectorAll('[data-open-active-screenshot]').forEach(button => {
    button.addEventListener('click', () => {
      const tour = button.closest('.product-tour');
      const panel = tour?.querySelector('[data-tour-panel]:not([hidden])');
      const target = panel?.querySelector('[data-screenshot]');
      if (target) openScreenshot(target, button);
    });
  });
  previousButton?.addEventListener('click', () => showScreenshot(screenshotIndex - 1));
  nextButton?.addEventListener('click', () => showScreenshot(screenshotIndex + 1));
  zoomButton?.addEventListener('click', () => {
    if (screenshotState !== 'ready') return;
    dialog.classList.toggle('is-zoomed');
    lightboxScroll.scrollTo(0, 0);
    updateScreenshotControls();
  });
  fullImage.addEventListener('error', () => {
    if (!dialog.open || !fullImage.getAttribute('src')) return;
    screenshotState = 'failed';
    fullImage.hidden = true;
    updateScreenshotControls();
  });
  dialog.addEventListener('keydown', event => {
    if (!dialog.open || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')) return;
    if (dialog.classList.contains('is-zoomed') && lightboxScroll.contains(event.target)) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    showScreenshot(screenshotIndex + (event.key === 'ArrowLeft' ? -1 : 1));
  });
  document.querySelector('#close-screenshot').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    imageGeneration += 1;
    if (pendingImage) { pendingImage.onload = null; pendingImage.onerror = null; pendingImage = null; }
    document.body.classList.remove('dialog-open');
    dialog.classList.remove('is-zoomed');
    fullImage.removeAttribute('src');
    fullImage.hidden = true;
    openedImage = null;
    screenshotIndex = -1;
    screenshotState = '';
    updateScreenshotControls();
    opener?.focus({preventScroll: true});
    opener = null;
  });
  updateScreenshotControls();
})();
