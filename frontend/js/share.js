/**
 * GhostShare: sends an encrypted emoji packet to other apps without changing it.
 *
 * Why this exists: an encrypted packet is hundreds of emoji, and every emoji takes 12 characters in a web link.
 * Long links get cut by WhatsApp, Telegram and mail apps, which silently breaks the packet. So:
 *   - short packets are placed in the link,
 *   - long packets are copied to the clipboard exactly as they are and the chat is opened for pasting,
 *   - a copy is always put on the clipboard as a backup (no auto-clear, so pasting a minute later still works).
 */
(function () {
  'use strict';
  const MAX_LINK = 1800; // characters in the finished link that apps reliably keep

  const toast = (m, t) => { if (window.UI && UI.showToast) UI.showToast(m, t || 'info'); else console.log(m); };

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) {}
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }

  // Small dialog with a phone/user field and a message box that is already filled in.
  function ask({ title, label, placeholder, message, needTarget = true }) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px';
      wrap.innerHTML = `<form style="background:#141722;color:#eee;border:1px solid #3a3470;border-radius:14px;padding:20px;width:min(520px,100%);display:grid;gap:12px;font:15px system-ui">
        <strong style="font-size:18px"></strong>
        ${needTarget ? '<label style="display:grid;gap:6px"><span data-l></span><input data-t autocomplete="off" style="padding:10px;border-radius:8px;border:1px solid #3a3470;background:#0b0d14;color:#fff"></label>' : ''}
        <label style="display:grid;gap:6px">Message (your encrypted text, sent exactly as it is)
          <textarea data-m rows="5" style="padding:10px;border-radius:8px;border:1px solid #3a3470;background:#0b0d14;color:#fff;font-size:18px"></textarea></label>
        <div style="display:flex;gap:10px;justify-content:flex-end"><button type="button" data-x style="padding:10px 16px;border-radius:8px;border:1px solid #555;background:none;color:#ddd">Cancel</button>
        <button type="submit" style="padding:10px 18px;border-radius:8px;border:0;background:#b9a7ff;color:#150f33;font-weight:700">Continue</button></div></form>`;
      wrap.querySelector('strong').textContent = title;
      if (needTarget) { wrap.querySelector('[data-l]').textContent = label; wrap.querySelector('[data-t]').placeholder = placeholder || ''; }
      const m = wrap.querySelector('[data-m]'); m.value = message || '';
      const done = v => { wrap.remove(); resolve(v); };
      wrap.querySelector('[data-x]').onclick = () => done(null);
      wrap.querySelector('form').onsubmit = e => {
        e.preventDefault();
        const target = needTarget ? wrap.querySelector('[data-t]').value.trim() : '';
        const message = m.value.trim();
        if ((needTarget && !target) || !message) return;
        done({ target, message });
      };
      document.body.appendChild(wrap);
      (needTarget ? wrap.querySelector('[data-t]') : m).focus();
    });
  }

  const latest = () => (window.EncryptionModule && EncryptionModule._lastPacket) || '';

  async function viaLink(name, makeLink, openPlain, text) {
    const link = makeLink(encodeURIComponent(text));
    const copied = await copy(text);
    if (link.length <= MAX_LINK) {
      window.open(link, '_blank', 'noopener');
      toast(`Opening ${name}.` + (copied ? ' A copy is also on your clipboard.' : ''), 'success');
    } else {
      window.open(openPlain, '_blank', 'noopener');
      toast(copied ? `Message copied. It is too long for a link, so paste it into ${name}.` : `Too long for a link. Copy the message and paste it into ${name}.`, copied ? 'success' : 'warning');
    }
  }

  window.GhostShare = {
    latest, copy, ask, MAX_LINK,
    async whatsapp(phone, text) {
      const p = String(phone).replace(/\D/g, ''); if (!p) return toast('Enter the phone number with country code.', 'warning');
      return viaLink('WhatsApp', e => `https://api.whatsapp.com/send?phone=${p}&text=${e}`, `https://wa.me/${p}`, text);
    },
    async telegram(user, text) {
      const u = String(user).replace(/^@/, '').trim(); if (!u) return;
      return viaLink('Telegram', e => `https://t.me/${encodeURIComponent(u)}?text=${e}`, `https://t.me/${encodeURIComponent(u)}`, text);
    },
    async email(addr, text) {
      const a = String(addr).trim(); if (!a) return;
      return viaLink('your email app', e => `mailto:${a}?subject=${encodeURIComponent('Encrypted GhostChat Message')}&body=${e}`, `mailto:${a}`, text);
    },
    async sms(phone, text) {
      const p = String(phone).trim(); if (!p) return;
      return viaLink('Messages', e => `sms:${p}?body=${e}`, `sms:${p}`, text);
    },
  };
})();
