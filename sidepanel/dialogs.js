/**
 * Native <dialog> modal controllers (Add Account, Settings/Filters, Confirm Action)
 * with closedby="any" fallback and proper returnValue cleanup.
 */

import { isValidHandle, normalizeHandle } from '../shared/utils.js';

let initialized = false;

/**
 * Install progressive fallback for <dialog closedby="any"> when unsupported.
 */
function installClosedByFallback() {
  if ('closedBy' in HTMLDialogElement.prototype) {
    return;
  }
  const outside = (e, dialog) => {
    const r = dialog.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    let pressedOutside = false;
    dialog.addEventListener('pointerdown', (e) => {
      pressedOutside = outside(e, dialog);
    });
    dialog.addEventListener('pointerup', (e) => {
      if (pressedOutside && outside(e, dialog)) {
        dialog.close('');
      }
      pressedOutside = false;
    });
  }
}

export function initDialogs() {
  if (initialized) return;
  initialized = true;
  installClosedByFallback();

  document.querySelectorAll('[data-close-dialog]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-close-dialog');
      const dlg = id ? document.getElementById(id) : btn.closest('dialog');
      if (dlg?.open) dlg.close('');
    });
  });

  document.querySelectorAll('dialog').forEach((dlg) => {
    dlg.addEventListener('close', () => {
      dlg.returnValue = '';
    });
  });
}

/**
 * Show a non-blocking native modal confirmation dialog replacing window.confirm().
 * @param {{ title: string, message: string, confirmLabel?: string }} opts
 * @returns {Promise<boolean>}
 */
export function showConfirmDialog({ title = 'Confirm Action', message, confirmLabel = 'Confirm' }) {
  const dlg = document.getElementById('confirmDialog');
  const titleEl = document.getElementById('confirmTitle');
  const msgEl = document.getElementById('confirmMessage');
  const okBtn = document.getElementById('confirmOkBtn');

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = confirmLabel;

  return new Promise((resolve) => {
    const onClose = () => {
      const confirmed = dlg.returnValue === 'confirm';
      dlg.returnValue = '';
      dlg.removeEventListener('close', onClose);
      resolve(confirmed);
    };
    dlg.addEventListener('close', onClose);
    dlg.showModal();
  });
}

/**
 * Open Add Account dialog and return validated username or null.
 * @param {() => Promise<Object|null>} onDetectActive
 */
export function openAddAccountDialog(onDetectActive) {
  const dlg = document.getElementById('addAccountDialog');
  const form = document.getElementById('addAccountForm');
  const input = document.getElementById('addAccountInput');
  const errorEl = document.getElementById('addAccountError');
  const detectBtn = document.getElementById('detectAccountInDialogBtn');

  input.value = '';
  input.removeAttribute('aria-invalid');
  errorEl.hidden = true;
  errorEl.textContent = '';

  return new Promise((resolve) => {
    const cleanup = () => {
      form.removeEventListener('submit', onSubmit);
      dlg.removeEventListener('close', onClose);
      detectBtn.removeEventListener('click', onDetectClick);
    };

    const onDetectClick = async () => {
      detectBtn.disabled = true;
      detectBtn.textContent = 'Detecting active X session…';
      try {
        const detected = await onDetectActive();
        if (detected?.username) {
          input.value = detected.username;
          input.removeAttribute('aria-invalid');
          errorEl.hidden = true;
        } else {
          errorEl.textContent = 'Could not detect an active logged-in X tab. Enter handle manually.';
          errorEl.hidden = false;
        }
      } catch (err) {
        errorEl.textContent = err?.message || 'Detection failed.';
        errorEl.hidden = false;
      } finally {
        detectBtn.disabled = false;
        detectBtn.textContent = 'Detect Active Logged-In X Account';
      }
    };

    const onSubmit = (e) => {
      const clean = normalizeHandle(input.value);
      if (!isValidHandle(clean)) {
        e.preventDefault();
        input.setAttribute('aria-invalid', 'true');
        errorEl.textContent = 'Enter a valid 1–15 character X handle (letters, numbers, underscores).';
        errorEl.hidden = false;
        input.focus();
        return;
      }
      dlg.close('save');
    };

    const onClose = () => {
      const saved = dlg.returnValue === 'save' ? normalizeHandle(input.value) : null;
      dlg.returnValue = '';
      cleanup();
      resolve(saved);
    };

    detectBtn.addEventListener('click', onDetectClick);
    form.addEventListener('submit', onSubmit);
    dlg.addEventListener('close', onClose);
    dlg.showModal();
    input.focus();
  });
}
