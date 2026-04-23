
(function (global) {


  if (!document.getElementById('go-modal-styles')) {
    const style = document.createElement('style');
    style.id = 'go-modal-styles';
    style.textContent = `
      .go-modal-backdrop {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,.55);
        backdrop-filter: blur(4px);
        display: flex; align-items: center; justify-content: center;
        padding: 1rem;
        opacity: 0; transition: opacity 220ms ease;
      }
      .go-modal-backdrop.go-visible { opacity: 1; }

      .go-modal {
        background: #fff; border-radius: 18px;
        box-shadow: 0 24px 60px rgba(0,0,0,.22);
        padding: 2rem 2rem 1.6rem;
        width: 100%; max-width: 420px;
        text-align: center;
        transform: scale(.88) translateY(20px);
        transition: transform 260ms cubic-bezier(.34,1.56,.64,1);
        position: relative;
      }
      .go-modal-backdrop.go-visible .go-modal { transform: scale(1) translateY(0); }

      /* Icono */
      .go-modal-icon {
        width: 72px; height: 72px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        margin: 0 auto 1.1rem;
        font-size: 2rem;
      }
      .go-modal-icon.success { background: #ecfdf5; color: #0b7a31; }
      .go-modal-icon.error   { background: #fff1f1; color: #c62828; }
      .go-modal-icon.warning { background: #fffbeb; color: #b45309; }
      .go-modal-icon.info    { background: #eff6ff; color: #1d4ed8; }
      .go-modal-icon.confirm { background: #fff7ed; color: #e85d04; }

      .go-modal-title {
        font-size: 1.35rem; font-weight: 700;
        color: #111; margin: 0 0 .5rem;
      }
      .go-modal-text {
        font-size: .97rem; color: #4b5563;
        margin: 0 0 1.4rem; line-height: 1.5;
      }

      /* Botones */
      .go-modal-actions {
        display: flex; gap: .7rem; justify-content: center; flex-wrap: wrap;
      }
      .go-modal-btn {
        padding: .65rem 1.6rem; border-radius: 10px;
        font-size: .95rem; font-weight: 600; cursor: pointer;
        border: none; transition: filter 160ms, transform 100ms;
        min-width: 110px;
      }
      .go-modal-btn:hover  { filter: brightness(1.08); }
      .go-modal-btn:active { transform: scale(.97); }
      .go-modal-btn.primary   { background: #e85d04; color: #fff; }
      .go-modal-btn.secondary { background: #f3f4f6; color: #374151; }
      .go-modal-btn.danger    { background: #c62828; color: #fff; }

      /* Barra de progreso (auto-close) */
      .go-modal-progress {
        position: absolute; bottom: 0; left: 0;
        height: 4px; border-radius: 0 0 18px 18px;
        background: #e85d04;
        width: 100%;
        transform-origin: left;
        animation: go-progress linear forwards;
      }
      @keyframes go-progress {
        from { transform: scaleX(1); }
        to   { transform: scaleX(0); }
      }

      /* Dark mode */
      @media (prefers-color-scheme: dark) {
        .go-modal { background: #1f2937; }
        .go-modal-title { color: #f9fafb; }
        .go-modal-text  { color: #9ca3af; }
        .go-modal-btn.secondary { background: #374151; color: #e5e7eb; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Iconos SVG por tipo ───────────────────────────────────
  const ICONS = {
    success: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
    warning: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info:    `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`,
    confirm: `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  };

  // ── Core: crear y mostrar modal ───────────────────────────
  function show(opts) {
    return new Promise((resolve) => {
      const {
        type       = 'info',
        title      = '',
        text       = '',
        confirmText   = 'Aceptar',
        cancelText    = 'Cancelar',
        showCancel    = false,
        autoClose     = 0,       // ms, 0 = sin auto-cierre
        onConfirm     = null,
        onCancel      = null,
      } = opts;

      // Backdrop
      const backdrop = document.createElement('div');
      backdrop.className = 'go-modal-backdrop';

      backdrop.innerHTML = `
        <div class="go-modal" role="dialog" aria-modal="true" aria-labelledby="go-modal-title">
          <div class="go-modal-icon ${type}">${ICONS[type] || ICONS.info}</div>
          <h2 class="go-modal-title" id="go-modal-title">${title}</h2>
          ${text ? `<p class="go-modal-text">${text}</p>` : ''}
          <div class="go-modal-actions">
            ${showCancel ? `<button class="go-modal-btn secondary" id="go-modal-cancel">${cancelText}</button>` : ''}
            <button class="go-modal-btn ${type === 'error' ? 'danger' : 'primary'}" id="go-modal-confirm">${confirmText}</button>
          </div>
          ${autoClose ? `<div class="go-modal-progress" style="animation-duration:${autoClose}ms"></div>` : ''}
        </div>
      `;

      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('go-visible'));

      function close(result) {
        backdrop.classList.remove('go-visible');
        setTimeout(() => backdrop.remove(), 260);
        resolve(result);
      }

      backdrop.querySelector('#go-modal-confirm').addEventListener('click', () => {
        if (onConfirm) onConfirm();
        close(true);
      });

      const cancelBtn = backdrop.querySelector('#go-modal-cancel');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
          if (onCancel) onCancel();
          close(false);
        });
      }

      // Cerrar con Escape
      function onKey(e) {
        if (e.key === 'Escape') { close(false); document.removeEventListener('keydown', onKey); }
      }
      document.addEventListener('keydown', onKey);

      // Auto-close
      if (autoClose) setTimeout(() => close(true), autoClose);
    });
  }

  // ── API pública ───────────────────────────────────────────
  const Modal = {
    success: (title, text, opts = {}) => show({ type: 'success', title, text, ...opts }),
    error:   (title, text, opts = {}) => show({ type: 'error',   title, text, ...opts }),
    warning: (title, text, opts = {}) => show({ type: 'warning', title, text, ...opts }),
    info:    (title, text, opts = {}) => show({ type: 'info',    title, text, ...opts }),
    confirm: (title, text, opts = {}) => show({ type: 'confirm', title, text, showCancel: true, ...opts }),
  };

  // Exponer globalmente
  global.Modal = Modal;

})(window);