'use strict';

(() => {
  const languageButton = document.querySelector('#language');
  const copyButton = document.querySelector('#copy-install');
  const feedback = document.querySelector('#copy-feedback');
  const code = document.querySelector('#install-code');
  const dialog = document.querySelector('#screenshot-dialog');
  const fullImage = document.querySelector('#screenshot-full');
  const caption = document.querySelector('#screenshot-caption');
  let language = 'zh';
  let copyState = '';
  let copying = false;
  let openedImage = null;
  let opener = null;

  const translatedText = [...document.querySelectorAll('[data-en]')].map(node => ({node, zh: node.textContent, en: node.dataset.en}));
  const translatedAlt = [...document.querySelectorAll('[data-alt-en]')].map(node => ({node, zh: node.alt, en: node.dataset.altEn}));
  const translatedAria = [...document.querySelectorAll('[data-aria-en]')].map(node => ({node, zh: node.getAttribute('aria-label'), en: node.dataset.ariaEn}));
  const feedbackText = {
    zh: {success: '已复制安装命令。', failed: '未能复制，请选中命令后手动复制。'},
    en: {success: 'Installation command copied.', failed: 'Copy failed. Select the command and copy it manually.'},
  };

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
    if (openedImage) { fullImage.alt = openedImage.alt; caption.textContent = openedImage.alt; }
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

  document.querySelectorAll('[data-screenshot]').forEach(button => {
    button.addEventListener('click', () => {
      const image = button.querySelector('img');
      if (!image || !image.complete || image.naturalWidth === 0) return;
      opener = button;
      openedImage = image;
      fullImage.src = image.currentSrc || image.src;
      fullImage.alt = image.alt;
      caption.textContent = image.alt;
      dialog.showModal();
      document.body.classList.add('dialog-open');
      dialog.querySelector('.lightbox-scroll').scrollTo(0, 0);
      document.querySelector('#close-screenshot').focus();
    });
  });
  document.querySelector('#close-screenshot').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
  dialog.addEventListener('close', () => {
    document.body.classList.remove('dialog-open');
    fullImage.removeAttribute('src');
    openedImage = null;
    opener?.focus({preventScroll: true});
    opener = null;
  });
})();
