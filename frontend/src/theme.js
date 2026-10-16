export function readTheme(storage) {
  try { return storage?.getItem('optesc-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}
export function applyTheme(root,logo,button,theme,storage) {
  const next=theme==='light'?'light':'dark';
  root.dataset.theme=next;
  logo.src=`./assets/logo-optesc-${next==='light'?'black':'white'}.png`;
  button.textContent=next==='light'?'Dark mode':'Light mode';
  button.setAttribute('aria-label',`Switch to ${next==='light'?'dark':'light'} mode`);
  button.setAttribute('aria-pressed',String(next==='light'));
  try { storage?.setItem('optesc-theme',next); } catch { /* Theme switching also works without storage. */ }
}
