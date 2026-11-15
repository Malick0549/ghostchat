/**
 * GHOSTCHAT  ·  UI & Theme Module  v3.2
 * Handles toasts, clipboard, session status, sound feedback, and dark/light theme switching.
 *
 * FIX: playSound() existed but was never called anywhere in the app, so the
 * "Sound effects" setting in Settings did nothing. It's now invoked from
 * dashboard.js and chat-socket.js at the actual moments a notification fires
 * (encrypt success, decrypt success, new chat message) — see those files.
 * playSound() itself already correctly reads ghostchat_settings.soundEffects,
 * so no change was needed here beyond making sure something calls it.
 */

/* ── UI helpers ─────────────────────────────────────────────────── */
window.UI = {
  showToast(message, type = 'info', duration = 3500) {
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      document.body.appendChild(container);
    }
    const icons = {
      success: 'fa-check-circle',
      error:   'fa-exclamation-circle',
      info:    'fa-info-circle',
    };
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.innerHTML = `<i class="fas ${icons[type] || icons.info}"></i><span>${message}</span>`;
    container.appendChild(toast);

    requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('show')));

    setTimeout(() => {
      toast.classList.remove('show');
      toast.addEventListener('transitionend', () => toast.remove(), { once: true });
    }, duration);
  },

  updateSessionStatus(active = true) {
    document.querySelectorAll('.status-dot').forEach(dot => {
      dot.classList.toggle('offline', !active);
    });
    const txt = document.getElementById('sessionText');
    if (txt) txt.textContent = active ? 'Secure Session' : 'Session Ended';
  },

  // ── Sound ────────────────────────────────────────────────────────────────
  // One shared AudioContext. Phones only allow sound after a tap, so the first tap anywhere unlocks it;
  // creating a new context for every sound (the old way) stayed silent on phones.
  _audio: null,
  _audioInit() {
    if (this._audioBound) return;
    this._audioBound = true;
    const unlock = () => {
      try {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return;
        if (!this._audio) this._audio = new C();
        if (this._audio.state === 'suspended') this._audio.resume();
        // a silent tick completes the unlock on iPhones
        const b = this._audio.createBuffer(1, 1, 22050), src = this._audio.createBufferSource();
        src.buffer = b; src.connect(this._audio.destination); src.start(0);
      } catch (_) {}
    };
    ['pointerdown', 'touchend', 'click', 'keydown'].forEach(ev => window.addEventListener(ev, unlock, { passive: true }));
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this._audio && this._audio.state === 'suspended') this._audio.resume().catch(() => {});
    });
  },

  // Phone-style notification chime: bright, short "glockenspiel" notes that ring and fade quickly.
  _tone(freq, start, dur, vol, partials) {
    const ctx = this._audio, t = ctx.currentTime + start;
    const out = ctx.createGain();
    out.gain.setValueAtTime(0.0001, t);
    out.gain.exponentialRampToValueAtTime(vol, t + 0.006);          // instant "tap"
    out.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    out.connect(ctx.destination);
    (partials || [[1, 1], [2.76, 0.32], [5.4, 0.1]]).forEach(([mult, amp]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = freq * mult;
      g.gain.value = amp; o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + 0.05);
    });
  },

  playSound(type) {
    try {
      const s = localStorage.getItem('ghostchat_settings');
      if (s && !JSON.parse(s).soundEffects) return;
      this._audioInit();
      if (!this._audio) {
        const C = window.AudioContext || window.webkitAudioContext;
        if (!C) return;
        this._audio = new C();
      }
      const go = () => {
        if (type === 'error') {           // two short low blips
          const sq = [[1, 1], [2, 0.25]];
          this._tone(330, 0, 0.22, 0.28, sq); this._tone(262, 0.17, 0.32, 0.28, sq);
        } else if (type === 'success') {  // quick up-ding
          this._tone(1318.5, 0, 0.55, 0.30); this._tone(1760, 0.11, 0.7, 0.28);
        } else {                          // new message: three rising notes, like a phone tri-tone
          this._tone(1046.5, 0, 0.5, 0.32); this._tone(1318.5, 0.13, 0.5, 0.32); this._tone(1568, 0.26, 0.9, 0.32);
        }
      };
      if (this._audio.state === 'suspended') this._audio.resume().then(go).catch(() => {}); else go();
      if (type !== 'error' && navigator.vibrate) { try { navigator.vibrate(type === 'info' ? [70, 40, 70] : [30]); } catch (_) {} }
    } catch (_) {}
  },

  showNotification(title, body) {
    this.showToast(body || title, 'info');

    try {
      if (!('Notification' in window)) return;
      const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
      if (isMobile) return;
      const show = () => {
        try { new Notification(title, { body, icon: '👻' }); } catch (_) {}
      };
      if (Notification.permission === 'granted') show();
      else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => { if (p === 'granted') show(); });
      }
    } catch (_) {
      // Silently ignore — toast already shown above
    }
  },

  secureCopy(text, clearAfterMs = 30000) {
    navigator.clipboard.writeText(text)
      .then(() => {
        this.showToast('Copied to clipboard', 'success');
        if (clearAfterMs > 0) {
          setTimeout(async () => {
            try {
              const cur = await navigator.clipboard.readText();
              if (cur === text) await navigator.clipboard.writeText('');
            } catch (_) {}
          }, clearAfterMs);
        }
      })
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        this.showToast('Copied!', 'success');
      });
  },
};
window.UI._audioInit();

/* ── Theme Manager (dark / light only) ──────────────────────────── */
class ThemeManager {
  constructor() {
    this.themes = {
      dark:  { name: 'Dark',  icon: 'fa-moon', file: 'dark.theme.css',  meta: '#0c0f16' },
    };
    this.order   = ['dark'];
    this.current = 'dark';
    if (!this.themes[this.current]) this.current = 'dark';
    this._apply(this.current);
  }

  _apply(name) {
    if (!this.themes[name]) name = 'dark';
    this.current = name;

    let link = document.getElementById('theme-stylesheet');
    if (!link) {
      link = document.createElement('link');
      link.id  = 'theme-stylesheet';
      link.rel = 'stylesheet';
      document.head.appendChild(link);
    }
    link.href = `themes/${this.themes[name].file}`;

    document.body.setAttribute('data-theme', name);
    localStorage.setItem('ghostchat_theme', name);

    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = this.themes[name].meta;

    this._syncUI(name);
    window.dispatchEvent(new CustomEvent('ghostchat:themeChanged', { detail: { theme: name } }));
  }

  _syncUI(name) {
    document.querySelectorAll(
      '#themeToggle i, #themeToggleLanding i, .theme-toggle-btn i'
    ).forEach(el => { el.className = `fas ${this.themes[name].icon}`; });

    document.querySelectorAll('.theme-option[data-theme]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === name);
    });
  }

  toggle() {
    const idx  = this.order.indexOf(this.current);
    const next = this.order[(idx + 1) % this.order.length];
    this._apply(next);
  }

  set(name)  { this._apply(name); }
  get()      { return this.current; }
}

/* ── Boot ───────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', function () {
  window.themeManager = new ThemeManager();

  document.querySelectorAll('#themeToggle, #themeToggleLanding, .theme-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => window.themeManager.toggle());
  });

  document.querySelectorAll('.theme-option[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => window.themeManager.set(btn.dataset.theme));
  });
});