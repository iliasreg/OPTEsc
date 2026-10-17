import { readTheme, applyTheme } from './theme.js';

export function initWelcome({ onFile, onSample }) {
  const home = document.createElement('div');
  home.id = 'welcome';
  home.innerHTML = `
    <div class="welcome-shell">
      <header class="welcome-header">
        <img id="welcome-logo" src="./assets/logo-optesc-white.png" alt="OPTEsc" width="110" height="68">
        <div class="welcome-header-right"><span class="welcome-mono">Field console</span><button id="welcome-theme" type="button">Light mode</button></div>
      </header>
      <main id="welcome-home" class="welcome-layout">
        <section aria-labelledby="welcome-title">
          <p class="welcome-eyebrow welcome-mono">Before the drill</p>
          <h1 id="welcome-title">Start with a plan.<br><em>See a way out.</em></h1>
          <div class="welcome-steps" aria-label="What you can do">
            <p><span>01</span>Build a view of your space.</p>
            <p><span>02</span>See how hazards change the drill.</p>
            <p><span>03</span>Export an equipment placement plan.</p>
          </div>
        </section>
        <section class="welcome-start" aria-label="Start a project">
          <div class="welcome-section-label welcome-mono"><b>New project</b><span>01 / Plan input</span></div>
          <div class="welcome-drop" id="welcome-drop">
            <svg class="welcome-plan-mark" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M5 5h24v13h14v25H5V5ZM5 28h14v15M29 5v13M19 28h9M29 28h14M12 5v9M5 21h8M35 43v-8" stroke="currentColor" stroke-width="1.5"/></svg>
            <h2>Drop your floor plan here</h2><p>or choose a file from your computer</p>
            <button class="welcome-primary" id="welcome-choose" type="button">Choose a plan</button>
            <input id="welcome-file" type="file" accept=".dxf,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.gif" aria-label="Choose your floor plan" hidden>
            <span class="welcome-formats">DXF / PDF / IMAGES</span>
          </div>
          <p class="welcome-upload-note">DXF gives the most precise scale. PDF and images may need scale review. Imported plans need a reviewed exit policy before a drill can run.</p>
          <button class="welcome-sample" id="welcome-sample" type="button"><span><span class="welcome-demo-title">Just looking? Explore the sample factory.</span><small>Open the reviewed demo in the workspace.</small></span><span class="welcome-arrow" aria-hidden="true">↗</span></button>
          <div id="welcome-message" role="status" aria-live="polite"></div>
        </section>
      </main>
      <section id="welcome-loading" class="welcome-loading" tabindex="-1" aria-live="polite" aria-atomic="true" hidden>
        <span class="welcome-spinner" aria-hidden="true"></span>
        <p class="welcome-mono">Opening your plan</p>
        <h1 id="welcome-loading-name"></h1>
        <p>Preparing the workspace. Please wait.</p>
      </section>
    </div>`;
  document.body.prepend(home);
  const get = id => document.getElementById(id);
  const loading = get('welcome-loading');
  loading.setAttribute('role', 'status');
  function screen(value) {
    document.body.dataset.screen = value;
    home.hidden = value === 'workspace';
    home.inert = value === 'workspace';
    get('welcome-home').hidden = value !== 'home';
    loading.hidden = value !== 'loading';
    for (const element of document.querySelectorAll('#main, #workspace-toolbar, #workspace-panel, #workspace-internal')) {
      element.inert = value !== 'workspace';
    }
  }
  function showHome() {
    screen('home');
    get('welcome-message').textContent = '';
    get('welcome-file').value = '';
  }
  const ui = {
    showLoading(name) {
      get('welcome-loading-name').textContent = name || 'Floor plan';
      screen('loading');
      loading.focus();
    },
    showWorkspace() { screen('workspace'); },
    showError(message) {
      showHome();
      get('welcome-message').textContent = message || 'Unable to open this plan. Choose another file.';
      get('welcome-choose').focus();
    },
    showHome,
  };
  const root = document.documentElement, logo = get('welcome-logo'), themeButton = get('welcome-theme');
  let storage = null;
  try { storage = window.localStorage; } catch { /* Theme controls remain usable without storage. */ }
  function syncTheme() {
    // A detached target updates controls without re-triggering the root observer.
    const target = { dataset: {} };
    applyTheme(target, logo, themeButton, root.dataset.theme, null);
    const workspaceLogo = document.querySelector('.workspace-brand img');
    const workspaceButton = get('theme-toggle');
    if (workspaceLogo && workspaceButton) applyTheme(target, workspaceLogo, workspaceButton, root.dataset.theme, null);
  }
  applyTheme(root, logo, themeButton, root.dataset.theme || readTheme(storage), storage);
  syncTheme();
  themeButton.addEventListener('click', () => {
    applyTheme(root, logo, themeButton, root.dataset.theme === 'light' ? 'dark' : 'light', storage);
    syncTheme();
  });
  new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
  const input = get('welcome-file'), drop = get('welcome-drop');
  function select(file) {
    input.value = '';
    if (!file) return;
    if (!/\.(dxf|pdf|png|jpe?g|webp|bmp|gif)$/i.test(file.name)) {
      ui.showError('Choose a DXF, PDF or image file.');
      return;
    }
    if (!file.size) {
      ui.showError('This file is empty. Choose another plan.');
      return;
    }
    get('welcome-message').textContent = '';
    onFile(file);
  }
  get('welcome-choose').addEventListener('click', () => input.click());
  input.addEventListener('change', () => select(input.files?.[0]));
  for (const type of ['dragenter', 'dragover']) drop.addEventListener(type, event => {
    event.preventDefault();
    drop.classList.add('drag');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('drag');
    select(event.dataTransfer?.files?.[0]);
  });
  get('welcome-sample').addEventListener('click', () => onSample());
  showHome();
  return ui;
}
