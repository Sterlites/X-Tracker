/**
 * Encapsulated Shadow DOM in-page HUD and optional Profile Status Pill.
 * Isolated from X's styles via attachShadow + adoptedStyleSheets.
 */
(function initXTrackerHud(root) {
  const HUD_HOST_ID = 'x-tracker-hud-host';
  const PILL_HOST_ID = 'x-tracker-profile-pill-host';

  const HUD_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset-block-start: 16px;
      inset-inline-end: 16px;
      z-index: 2147483640;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color-scheme: dark;
    }
    .hud {
      width: min(330px, calc(100vw - 32px));
      background: rgba(11, 15, 23, 0.94);
      color: #f1f5f9;
      border: 1px solid rgba(148, 163, 184, 0.28);
      border-radius: 12px;
      padding: 12px 14px;
      box-shadow: 0 12px 32px rgba(2, 6, 23, 0.55);
      backdrop-filter: blur(10px);
      display: grid;
      gap: 8px;
    }
    .hud[data-tone="error"] {
      border-color: rgba(251, 113, 133, 0.55);
    }
    .hud[data-tone="success"] {
      border-color: rgba(52, 211, 153, 0.55);
    }
    .hud[data-tone="paused"] {
      border-color: rgba(251, 191, 36, 0.55);
    }
    .top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      background: #38bdf8;
      flex-shrink: 0;
    }
    .hud[data-tone="scanning"] .dot {
      animation: pulse 1.6s ease-in-out infinite;
    }
    .hud[data-tone="paused"] .dot {
      background: #fbbf24;
    }
    .hud[data-tone="success"] .dot {
      background: #34d399;
    }
    .hud[data-tone="error"] .dot {
      background: #fb7185;
    }
    .title {
      font-size: 13px;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .source-tag {
      font-size: 11px;
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.16);
      border: 1px solid rgba(59, 130, 246, 0.32);
      padding: 2px 6px;
      border-radius: 999px;
      flex-shrink: 0;
    }
    .status {
      font-size: 12px;
      color: #cbd5e1;
      line-height: 1.4;
      word-break: break-word;
    }
    progress {
      width: 100%;
      height: 6px;
      border: 0;
      border-radius: 999px;
      overflow: hidden;
      background: rgba(148, 163, 184, 0.22);
      accent-color: #38bdf8;
    }
    progress::-webkit-progress-bar {
      background: rgba(148, 163, 184, 0.22);
      border-radius: 999px;
    }
    progress::-webkit-progress-value {
      background: #38bdf8;
      border-radius: 999px;
      transition: width 0.2s ease;
    }
    .actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }
    button {
      font-family: inherit;
      font-size: 12px;
      font-weight: 600;
      padding: 5px 10px;
      border-radius: 7px;
      border: 1px solid rgba(148, 163, 184, 0.32);
      background: rgba(255, 255, 255, 0.08);
      color: #f1f5f9;
      cursor: pointer;
      transition: background 0.15s ease;
    }
    button:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.16);
    }
    button:focus-visible {
      outline: 2px solid #67e8f9;
      outline-offset: 2px;
    }
    button.danger {
      color: #fda4af;
      border-color: rgba(251, 113, 133, 0.4);
      background: rgba(244, 63, 94, 0.15);
    }
    button.danger:hover:not(:disabled) {
      background: rgba(244, 63, 94, 0.28);
    }
    button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.45; transform: scale(1.2); }
    }
    @media (prefers-reduced-motion: reduce) {
      .hud[data-tone="scanning"] .dot { animation: none; }
      progress::-webkit-progress-value { transition: none; }
    }
  `;

  const PILL_CSS = `
    :host {
      all: initial;
      position: fixed;
      inset-block-end: 16px;
      inset-inline-end: 16px;
      z-index: 2147483635;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(11, 15, 23, 0.92);
      color: #f1f5f9;
      border: 1px solid rgba(148, 163, 184, 0.3);
      box-shadow: 0 8px 24px rgba(2, 6, 23, 0.45);
      font-size: 12px;
      font-weight: 500;
    }
    .badge {
      font-weight: 700;
      color: #6ee7b7;
    }
    .pill[data-tone="loss"] .badge {
      color: #fda4af;
    }
    .pill[data-tone="neutral"] .badge {
      color: #93c5fd;
    }
    button {
      background: transparent;
      border: 0;
      color: #cbd5e1;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      padding: 2px 4px;
      border-radius: 4px;
    }
    button:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.12);
    }
  `;

  function applyShadowStyles(shadowRoot, cssText) {
    if (typeof CSSStyleSheet !== 'undefined' && 'adoptedStyleSheets' in shadowRoot) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(cssText);
      shadowRoot.adoptedStyleSheets = [sheet];
    } else {
      const style = document.createElement('style');
      style.textContent = cssText;
      shadowRoot.appendChild(style);
    }
  }

  let hudRefs = null;
  let removeTimer = null;

  function mountHud({ title = 'X Tracker', source = 'GraphQL + DOM', onPauseToggle, onStop } = {}) {
    clearTimeout(removeTimer);
    removeHudImmediate();

    const host = document.createElement('div');
    host.id = HUD_HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    applyShadowStyles(shadow, HUD_CSS);

    const card = document.createElement('div');
    card.className = 'hud';
    card.dataset.tone = 'scanning';
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');

    const top = document.createElement('div');
    top.className = 'top';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'title-wrap';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.setAttribute('aria-hidden', 'true');
    const titleEl = document.createElement('span');
    titleEl.className = 'title';
    titleEl.textContent = title;
    titleWrap.append(dot, titleEl);

    const sourceEl = document.createElement('span');
    sourceEl.className = 'source-tag';
    sourceEl.textContent = source;

    top.append(titleWrap, sourceEl);

    const statusEl = document.createElement('div');
    statusEl.className = 'status';
    statusEl.textContent = 'Preparing scan...';

    const progressEl = document.createElement('progress');
    progressEl.max = 100;
    progressEl.value = 0;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.textContent = 'Pause';
    pauseBtn.addEventListener('click', () => {
      if (typeof onPauseToggle === 'function') onPauseToggle();
    });

    const stopBtn = document.createElement('button');
    stopBtn.type = 'button';
    stopBtn.className = 'danger';
    stopBtn.textContent = 'Stop & Save';
    stopBtn.addEventListener('click', () => {
      stopBtn.disabled = true;
      pauseBtn.disabled = true;
      stopBtn.textContent = 'Saving...';
      if (typeof onStop === 'function') onStop();
    });

    actions.append(pauseBtn, stopBtn);
    card.append(top, statusEl, progressEl, actions);
    shadow.appendChild(card);

    (document.body || document.documentElement).appendChild(host);
    hudRefs = { host, card, titleEl, sourceEl, statusEl, progressEl, pauseBtn, stopBtn, actions };
    return hudRefs;
  }

  function updateHud({ title, status, progress, tone, source, pauseLabel, showActions = true } = {}) {
    if (!hudRefs) return;
    if (title !== undefined) hudRefs.titleEl.textContent = title;
    if (status !== undefined) hudRefs.statusEl.textContent = status;
    if (source !== undefined) hudRefs.sourceEl.textContent = source;
    if (tone !== undefined) hudRefs.card.dataset.tone = tone;
    if (pauseLabel !== undefined) hudRefs.pauseBtn.textContent = pauseLabel;
    if (Number.isFinite(progress)) {
      hudRefs.progressEl.value = Math.max(0, Math.min(100, progress));
    }
    hudRefs.actions.style.display = showActions ? 'flex' : 'none';
  }

  function removeHud(delayMs = 0) {
    clearTimeout(removeTimer);
    if (delayMs <= 0) {
      removeHudImmediate();
      return;
    }
    removeTimer = setTimeout(removeHudImmediate, delayMs);
  }

  function removeHudImmediate() {
    hudRefs = null;
    const existing = document.getElementById(HUD_HOST_ID);
    if (existing) existing.remove();
  }

  function showProfilePill({ badgeText, detailText, tone = 'neutral' }) {
    removeProfilePill();
    const host = document.createElement('div');
    host.id = PILL_HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    applyShadowStyles(shadow, PILL_CSS);

    const pill = document.createElement('div');
    pill.className = 'pill';
    pill.dataset.tone = tone;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = badgeText;

    const detail = document.createElement('span');
    detail.textContent = detailText;

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'Dismiss X Tracker badge');
    closeBtn.textContent = '×';
    closeBtn.addEventListener('click', removeProfilePill);

    pill.append(badge, detail, closeBtn);
    shadow.appendChild(pill);
    (document.body || document.documentElement).appendChild(host);
  }

  function removeProfilePill() {
    const existing = document.getElementById(PILL_HOST_ID);
    if (existing) existing.remove();
  }

  root.__XTrackerHud = {
    mountHud,
    updateHud,
    removeHud,
    showProfilePill,
    removeProfilePill
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
