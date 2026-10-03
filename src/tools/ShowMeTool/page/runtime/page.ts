// Verbatim copy of upstream src/runtime/page.js, embedded as a string constant.
// Do not edit by hand; regenerate from the upstream file.
export const RUNTIME_JS = `(() => {
  const root = document.documentElement;
  const cycle = (list, cur) => list[(list.indexOf(cur) + 1) % list.length];
  const label = (btn, value) => {
    const map = JSON.parse(btn.dataset.labels || '{}');
    btn.textContent = map[value] || value;
  };
  const bind = (name, attr, values) => {
    const btn = document.querySelector(\`[data-am="\${name}"]\`);
    if (!btn) return;
    label(btn, root.getAttribute(attr));
    btn.addEventListener('click', () => {
      const next = cycle(values, root.getAttribute(attr));
      root.setAttribute(attr, next);
      label(btn, next);
    });
  };
  bind('theme', 'data-theme', ['blueprint', 'shadcn']);
  bind('mode', 'data-mode', ['auto', 'light', 'dark']);

  const copyBtn = document.querySelector('[data-am="copy"]');
  copyBtn?.addEventListener('click', async () => {
    const text = document.getElementById('am-source').value;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.append(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    const original = copyBtn.textContent;
    copyBtn.textContent = copyBtn.dataset.done;
    setTimeout(() => { copyBtn.textContent = original; }, 1400);
  });
})();
`;
