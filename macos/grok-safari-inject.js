/* global document, location, HTMLTextAreaElement, HTMLInputElement */
(() => {
  const prompt = window.__mailboxPrompt;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const findInput = () =>
    document.querySelector('textarea') ||
    document.querySelector('[contenteditable="true"]') ||
    document.querySelector('[role="textbox"]');
  const findSend = () => {
    const buttons = [...document.querySelectorAll('button')];
    return (
      buttons.find(
        (b) =>
          /send/i.test(b.getAttribute('aria-label') || '') ||
          /send/i.test(b.textContent || '')
      ) || document.querySelector('button[type="submit"]')
    );
  };
  const snapshot = () => (document.body && document.body.innerText ? document.body.innerText : '');

  return (async () => {
    if (typeof prompt !== 'string' || !prompt) {
      return JSON.stringify({ ok: false, error: 'missing prompt' });
    }
    const before = snapshot();
    const input = findInput();
    if (!input) {
      return JSON.stringify({
        ok: false,
        error: `no grok.com composer found on ${location.pathname}`,
      });
    }
    input.focus();
    try {
      document.execCommand('selectAll');
      document.execCommand('insertText', false, prompt);
    } catch {
      if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
        input.value = prompt;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        input.textContent = prompt;
      }
    }
    await sleep(200);
    const send = findSend();
    if (send) send.click();
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    let last = snapshot();
    let stable = 0;
    for (let i = 0; i < 90; i += 1) {
      await sleep(1000);
      const now = snapshot();
      if (now.length > before.length + 20) {
        if (now === last) {
          stable += 1;
          if (stable >= 3) {
            return JSON.stringify({ ok: true, reply: now.slice(before.length).trim().slice(-12000) });
          }
        } else {
          stable = 0;
          last = now;
        }
      }
    }
    return JSON.stringify({ ok: false, error: 'timed out waiting for a grok.com reply' });
  })();
})();
