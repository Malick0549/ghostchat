/**
 * GHOSTCHAT  ·  UI & Theme Module  v3.1
 * Handles toasts, clipboard, session status, and dark/light theme switching.
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

  playSound(type) {
    try {
      const s = localStorage.getItem('ghostchat_settings');
      if (s && !JSON.parse(s).soundEffects) return;
      const ctx  = new (window.AudioContext || window.webkitAudioContext)();
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = type === 'success' ? 880 : 440;
      gain.gain.value = 0.08;
      osc.start();
      setTimeout(() => { osc.stop(); ctx.close(); }, 200);
    } catch (_) {}
  },

  showNotification(title, body) {
    if (!('Notification' in window)) return;
    const show = () => new Notification(title, { body, icon: '👻' });
    if (Notification.permission === 'granted') show();
    else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then(p => { if (p === 'granted') show(); });
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
        // Fallback for older browsers
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

/* ── Theme Manager (dark / light only) ──────────────────────────── */
class ThemeManager {
  constructor() {
    this.themes = {
      dark:  { name: 'Dark',  icon: 'fa-moon', file: 'dark.theme.css',  meta: '#080b12' },
      light: { name: 'Light', icon: 'fa-sun',  file: 'light.theme.css', meta: '#f0f4f8' },
    };
    this.order   = ['dark', 'light'];
    this.current = localStorage.getItem('ghostchat_theme') || 'dark';
    // Clamp any unrecognised stored theme to dark
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

    // Meta theme-color for mobile browsers
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
    // Sync toggle button icons
    document.querySelectorAll(
      '#themeToggle i, #themeToggleLanding i, .theme-toggle-btn i'
    ).forEach(el => { el.className = `fas ${this.themes[name].icon}`; });

    // Sync sidebar theme option chips
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

  // Wire all toggle buttons
  document.querySelectorAll('#themeToggle, #themeToggleLanding, .theme-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => window.themeManager.toggle());
  });

  // Wire sidebar theme chips
  document.querySelectorAll('.theme-option[data-theme]').forEach(btn => {
    btn.addEventListener('click', () => window.themeManager.set(btn.dataset.theme));
  });

  // Request notification permission (non-blocking)
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
});

/**
 * ENTER KEY NAVIGATION
 * Moves cursor to next input field when Enter key is pressed
 * Submits form on last field
 */

function setupEnterKeyNavigation() {
    // Find all forms on the page
    const forms = document.querySelectorAll('form');
    
    forms.forEach(form => {
        // Get all input fields in the form (text, email, password, etc.)
        const inputs = Array.from(form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select'));
        
        inputs.forEach((input, index) => {
            input.addEventListener('keypress', function(e) {
                // Only trigger on Enter key
                if (e.key === 'Enter') {
                    e.preventDefault();
                    
                    // If this is the last input, submit the form
                    if (index === inputs.length - 1) {
                        // Find and click the submit button
                        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
                        if (submitBtn) {
                            submitBtn.click();
                        } else {
                            form.submit();
                        }
                    } else {
                        // Move to next input
                        const nextInput = inputs[index + 1];
                        if (nextInput) {
                            nextInput.focus();
                            nextInput.select();
                        }
                    }
                }
            });
        });
    });
}

// Also handle modal/dialog forms that might appear after page load
function observeNewForms() {
    const observer = new MutationObserver(function(mutations) {
        mutations.forEach(function(mutation) {
            if (mutation.addedNodes.length) {
                mutation.addedNodes.forEach(function(node) {
                    if (node.nodeType === 1 && node.tagName === 'FORM') {
                        setupEnterKeyNavigationOnForm(node);
                    } else if (node.querySelectorAll) {
                        const forms = node.querySelectorAll('form');
                        forms.forEach(form => setupEnterKeyNavigationOnForm(form));
                    }
                });
            }
        });
    });
    
    observer.observe(document.body, { childList: true, subtree: true });
}

function setupEnterKeyNavigationOnForm(form) {
    const inputs = Array.from(form.querySelectorAll('input:not([type="submit"]):not([type="button"]):not([type="reset"]), textarea, select'));
    
    inputs.forEach((input, index) => {
        // Remove existing listener to avoid duplicates
        input.removeEventListener('keypress', handleEnterKey);
        // Add new listener
        input.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                
                if (index === inputs.length - 1) {
                    const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
                    if (submitBtn) {
                        submitBtn.click();
                    } else {
                        form.submit();
                    }
                } else {
                    const nextInput = inputs[index + 1];
                    if (nextInput) {
                        nextInput.focus();
                        nextInput.select();
                    }
                }
            }
        });
    });
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    setupEnterKeyNavigation();
    observeNewForms();
});
