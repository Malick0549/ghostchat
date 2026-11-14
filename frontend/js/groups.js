/**
 * GHOSTCHAT GROUPS  v1  — end-to-end encrypted group chats (chat page)
 *
 * How the encryption works
 *  • A group has a random AES-256-GCM key, made in a member's browser. The server never sees it.
 *  • The key is handed to each member "wrapped" with that member's own one-to-one end-to-end key
 *    (the same Automatic/Manual key you already use for 1:1 chats). The server only stores the wraps.
 *  • Messages and files are encrypted with the group key; the sender's id is bound into every message
 *    (AAD) so the server cannot make a message look like it came from someone else.
 *  • Keys are versioned. When someone joins, leaves or is removed, a new version is made for the people
 *    who are in the group now. Past members can't read what comes next; new members can't read what came before.
 *
 * Loads after chat-socket.js. Everything here is additive: with no groups, the chat page behaves as before.
 */
(function () {
    'use strict';
    const GG = '🔐GRP1:';
    const subtle = (globalThis.crypto || {}).subtle;
    const enc = new TextEncoder(), dec = new TextDecoder();
    const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
    const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const S = {
        groups: [], cur: null /* detail */, msgs: [], plain: {}, unread: {},
        keys: new Map(),          // `${gid}|${ver}` → CryptoKey
        maint: Promise.resolve(), busy: new Set(),
    };
    let chat = null, me = null;
    const E = () => window.GhostE2E;
    const toast = (m, t = 'info') => { try { chat._toast(m, t); } catch (_) { try { window.UI?.showToast(m, t); } catch (__) {} } };

    // ── tiny key store (this device only) ───────────────────────────────────────
    const idb = (() => {
        let p = null;
        const open = () => p || (p = new Promise((res, rej) => {
            const r = indexedDB.open('ghostchat-groups', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('k');
            r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
        }));
        const run = (mode, fn) => open().then(db => new Promise((res, rej) => { const t = db.transaction('k', mode), q = fn(t.objectStore('k')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
        return { get: k => run('readonly', s => s.get(k)), put: (k, v) => run('readwrite', s => s.put(v, k)) };
    })();
    window.addEventListener('ghoste2e:locked', () => { S.keys.clear(); S.plain = {}; try { if (S.cur) render(); } catch (_) {} });
    const kid = (gid, ver) => `${me}|${gid}|${ver}`;
    async function keyFor(gid, ver) {
        if (window.GhostE2E && GhostE2E.isLocked && GhostE2E.isLocked()) return null;     // auto-locked
        const ck = `${gid}|${ver}`;
        if (S.keys.has(ck)) return S.keys.get(ck);
        let raw = null; try { raw = await idb.get(kid(gid, ver)); } catch (_) {}
        if (!raw) return null;
        const k = await subtle.importKey('raw', unb64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']);
        S.keys.set(ck, k); return k;
    }
    async function saveKey(gid, ver, rawBytes) {
        await idb.put(kid(gid, ver), b64(rawBytes)); S.keys.delete(`${gid}|${ver}`);
    }
    async function rawOf(gid, ver) { try { return await idb.get(kid(gid, ver)); } catch (_) { return null; } }
    async function newestLocal(gid, upTo) {
        for (let v = upTo; v >= 1; v--) if (await keyFor(gid, v)) return v;
        return 0;
    }

    // ── api ─────────────────────────────────────────────────────────────────────
    async function api(method, path, body) {
        const h = { 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': chat._getCsrf() };
        let b; if (body instanceof FormData) b = body; else if (body) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
        try {
            const r = await fetch(`${chat._base()}${path}`, { method, credentials: 'include', headers: h, body: b });
            const d = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, d };
        } catch (_) { return { ok: false, status: 0, d: { error: 'Network problem. Check your connection.' } }; }
    }

    // ── group packets (message / file note) ─────────────────────────────────────
    async function seal(gid, text) {
        const ver = await newestLocal(gid, S.cur?.id === gid ? S.cur.key_version : 999);
        const key = ver && await keyFor(gid, ver);
        if (!key) return { ok: false, reason: 'no_group_key' };
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`gcgrp1|${gid}|${ver}|${me}`) }, key, enc.encode(text)));
        const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
        return { ok: true, packet: E().toEmoji(`${GG}${ver}:${b64(out)}`) };
    }
    async function open(gid, senderId, packet) {
        try {
            const s = E().unwrap(packet);
            if (typeof s !== 'string' || !s.startsWith(GG)) return null;
            const rest = s.slice(GG.length), i = rest.indexOf(':'), ver = parseInt(rest.slice(0, i), 10);
            const key = await keyFor(gid, ver); if (!key) return null;
            const raw = unb64(rest.slice(i + 1));
            return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: enc.encode(`gcgrp1|${gid}|${ver}|${senderId}`) }, key, raw.slice(12)));
        } catch (_) { return null; }
    }

    // ── key upkeep: collect my keys, make a new version when due, give keys to people who lack them ─────────
    function maintain(gid, force) {
        const run = async () => {
            if (S.busy.has(gid)) return; S.busy.add(gid);
            try { await _maintain(gid, force); } catch (e) { console.warn('[groups] key upkeep', e); } finally { S.busy.delete(gid); }
        };
        S.maint = S.maint.then(run, run); return S.maint;
    }
    async function _maintain(gid, force) {
        let r = await api('GET', `/api/groups/${gid}`); if (!r.ok) return;
        let g = r.d.group;
        // 1. collect the keys wrapped for me
        const kr = await api('GET', `/api/groups/${gid}/keys`);
        for (const k of (kr.d.keys || [])) {
            if (await keyFor(gid, k.version)) continue;
            try {
                const note = JSON.parse(await E().decrypt(k.sender_id, k.packet));
                if (note && note.t === 'gk' && note.g === gid && note.v === k.version && typeof note.k === 'string') await saveKey(gid, k.version, unb64(note.k));
            } catch (_) { /* cannot open this wrap on this device */ }
        }
        // 2. new version needed?
        if (g.role === 'admin' && (g.rekey_needed || g.key_version === 0 || force)) {
            const ver = g.key_version + 1, raw = crypto.getRandomValues(new Uint8Array(32)), note = JSON.stringify({ t: 'gk', g: gid, v: ver, k: b64(raw) });
            const keys = [], skipped = [];
            for (const m of g.members) {
                if (m.user_id === me) continue;
                const w = await E().encryptFor(m.user_id, note);
                if (w.ok) keys.push({ user_id: m.user_id, packet: w.packet }); else skipped.push(m.username);
            }
            if (keys.length || g.members.length === 1) {
                const body = keys.length ? { version: ver, keys } : { version: ver, keys: [{ user_id: me, packet: E().toEmoji('🔐GRP1:solo') }] };
                const pr = await api('POST', `/api/groups/${gid}/keys`, body);
                if (pr.ok) {
                    await saveKey(gid, ver, raw);
                    if (skipped.length) toast(`${skipped.join(', ')} ${skipped.length > 1 ? "haven't" : "hasn't"} turned on encryption yet. They will get the group key after they open GhostChat.`, 'info');
                } else if (pr.status !== 409) toast(pr.d.error || 'Could not set up the group key', 'error');
            } else if (skipped.length) {
                toast(`Encryption is not ready with ${skipped.join(', ')}. Ask them to open GhostChat, then try again.`, 'error');
            }
            r = await api('GET', `/api/groups/${gid}`); if (r.ok) g = r.d.group;
        }
        // 3. hand the current key to anyone who is missing it
        const cur = await rawOf(gid, g.key_version);
        const miss = (g.missing_keys || []).filter(u => u !== me);
        if (cur && miss.length) {
            const note = JSON.stringify({ t: 'gk', g: gid, v: g.key_version, k: cur }), keys = [];
            for (const u of miss) { const w = await E().encryptFor(u, note); if (w.ok) keys.push({ user_id: u, packet: w.packet }); }
            if (keys.length) await api('POST', `/api/groups/${gid}/keys`, { version: g.key_version, keys, sync: true });
        }
        if (S.cur?.id === gid) { S.cur = g; paintHeader(); }
        const row = S.groups.find(x => x.id === gid); if (row) { row.key_version = g.key_version; row.rekey_needed = g.rekey_needed; }
    }

    // ── styles ──────────────────────────────────────────────────────────────────
    function css() {
        if (document.getElementById('gg-css')) return;
        const st = document.createElement('style'); st.id = 'gg-css';
        st.textContent = `
        #ggSection{border-bottom:1px solid var(--border,rgba(255,255,255,.1));max-height:38vh;overflow:auto;flex:none}
        .gg-head{display:flex;align-items:center;justify-content:space-between;padding:10px 16px 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--t3,#7a9ab5)}
        .gg-head button{background:none;border:0;color:var(--primary,#00d4ff);cursor:pointer;font-size:13px;padding:4px 8px;border-radius:8px}
        .gg-head button:hover{background:var(--primary-dim,rgba(0,212,255,.12))}
        .gg-empty{padding:4px 16px 12px;font-size:13px;color:var(--t3,#7a9ab5)}
        .gg-av{display:flex;align-items:center;justify-content:center;background:var(--primary-dim,rgba(0,212,255,.15));color:var(--primary,#00d4ff)}
        .gg-sender{font-size:12px;font-weight:600;margin-bottom:2px}
        .gg-locked{opacity:.7;font-style:italic}
        .gg-sys{text-align:center;font-size:12px;color:var(--t3,#7a9ab5);margin:8px 0}
        .gg-del{position:absolute;top:4px;right:6px;background:none;border:0;color:inherit;opacity:.35;cursor:pointer;font-size:12px;padding:4px}
        .gg-del:hover{opacity:1;color:var(--red,#ff3b5c)}
        .msg-bubble{position:relative}
        .gg-modal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:9500;padding:16px}
        .gg-card{width:100%;max-width:440px;max-height:90vh;overflow:auto;background:var(--bg1,#12151f);color:var(--t1,#eef);border:1px solid var(--border,rgba(255,255,255,.15));border-radius:16px;padding:20px}
        .gg-card h3{margin:0 0 12px;font-size:18px}.gg-card label{display:block;font-size:13px;color:var(--t2,#9ab);margin:12px 0 4px}
        .gg-card input[type=text]{width:100%;padding:11px 12px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.2));background:var(--bg2,rgba(255,255,255,.05));color:inherit;font:inherit}
        .gg-pick{max-height:240px;overflow:auto;border:1px solid var(--border,rgba(255,255,255,.12));border-radius:10px}
        .gg-pick label,.gg-mem{display:flex;align-items:center;gap:10px;margin:0;padding:10px 12px;color:var(--t1,#eef);font-size:14px;cursor:pointer;border-bottom:1px solid var(--border,rgba(255,255,255,.06))}
        .gg-mem{cursor:default}.gg-mem .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
        .gg-tag{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--primary-dim,rgba(0,212,255,.15));color:var(--primary,#00d4ff)}
        .gg-row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}
        .gg-btn{padding:10px 16px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.2));background:transparent;color:inherit;cursor:pointer;font:inherit}
        .gg-btn.pri{background:var(--primary,#00d4ff);border-color:var(--primary,#00d4ff);color:#04060e;font-weight:600}
        .gg-btn.bad{border-color:var(--red,#ff3b5c);color:var(--red,#ff3b5c)}
        .gg-x{background:none;border:0;color:var(--red,#ff3b5c);cursor:pointer;padding:4px 8px}
        .gg-note{font-size:12.5px;color:var(--t2,#9ab);line-height:1.5;margin:10px 0 0}
        @media (max-width:768px){#ggSection{max-height:30vh}}`;
        document.head.appendChild(st);
    }

    // ── sidebar ─────────────────────────────────────────────────────────────────
    function ensureSection() {
        let sec = document.getElementById('ggSection');
        if (sec) return sec;
        const list = document.getElementById('contactsList'); if (!list) return null;
        css();
        sec = document.createElement('div'); sec.id = 'ggSection';
        sec.innerHTML = `<div class="gg-head"><span>Groups</span><button type="button" id="ggNew" title="New group" aria-label="Create a new group"><i class="fas fa-plus"></i> New</button></div><div id="ggList" role="list" aria-label="Your groups"></div>`;
        list.parentNode.insertBefore(sec, list);
        sec.querySelector('#ggNew').addEventListener('click', openCreate);
        return sec;
    }
    function paintList() {
        ensureSection(); const box = document.getElementById('ggList'); if (!box) return;
        if (!S.groups.length) { box.innerHTML = '<div class="gg-empty">No groups yet. Tap “New” to start one.</div>'; return; }
        box.innerHTML = S.groups.map(g => {
            const n = S.unread[g.id] || 0, active = S.cur?.id === g.id;
            return `<div class="contact-item ${active ? 'active' : ''}" role="button" tabindex="0" data-gid="${esc(g.id)}">
              <div class="contact-avatar gg-av"><i class="fas fa-users"></i></div>
              <div class="contact-info"><div class="contact-header"><span class="contact-name">${esc(g.name)}</span><span class="contact-time">${g.last_message_at ? chat._formatTime(g.last_message_at) : ''}</span></div>
              <div class="contact-footer"><span class="contact-preview">${g.member_count} people · 🔒 encrypted</span>${n ? `<span class="contact-unread">${n > 99 ? '99+' : n}</span>` : ''}</div></div></div>`;
        }).join('');
        box.querySelectorAll('[data-gid]').forEach(el => {
            const go = () => openGroup(el.dataset.gid);
            el.addEventListener('click', go); el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
        });
    }
    async function loadList() {
        const r = await api('GET', '/api/groups'); if (r.ok) { S.groups = r.d.groups || []; paintList(); }
        return S.groups;
    }

    // ── group view ──────────────────────────────────────────────────────────────
    const HIDE = ['encryptToggle', 'setPasswordBtn', 'chatMenuBtn'];
    function paintHeader() {
        if (!S.cur) return;
        const n = document.getElementById('chatHeaderName'), a = document.getElementById('chatHeaderAvatar'), st = document.getElementById('chatHeaderStatus');
        if (n) n.textContent = S.cur.name;
        if (a) a.innerHTML = '<i class="fas fa-users"></i>';
        if (st) { const ready = S.cur.key_version > 0; st.innerHTML = `<i class="fas fa-lock" style="font-size:.6rem;"></i> ${S.cur.member_count} people · ${ready ? 'End-to-end encrypted' : 'Setting up encryption…'}`; }
    }
    function modeUI(on) {
        HIDE.forEach(id => { const b = document.getElementById(id); if (b) b.style.display = on ? 'none' : ''; });
        let info = document.getElementById('ggInfoBtn');
        if (on && !info) {
            info = document.createElement('button'); info.className = 'icon-btn'; info.id = 'ggInfoBtn'; info.title = 'Group info'; info.setAttribute('aria-label', 'Group info');
            info.innerHTML = '<i class="fas fa-circle-info"></i>'; info.addEventListener('click', openInfo);
            document.querySelector('.chat-header-actions')?.appendChild(info);
        }
        if (info) info.style.display = on ? '' : 'none';
        const tw = document.getElementById('typingWrap'); if (tw && on) tw.style.display = 'none';
    }
    function exitView() {
        if (!S.cur) return;
        S.cur = null; S.msgs = []; modeUI(false); paintList();
    }
    async function openGroup(gid) {
        const r = await api('GET', `/api/groups/${gid}`);
        if (!r.ok) { toast(r.d.error || 'Could not open the group', 'error'); await loadList(); return; }
        chat.currentContact = null; chat._stopTyping?.();
        S.cur = r.d.group; S.unread[gid] = 0; S.msgs = [];
        document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
        document.getElementById('chatEmptyState').style.display = 'none';
        document.getElementById('chatWindow').style.display = 'flex';
        modeUI(true); paintHeader(); paintList();
        document.querySelector('.chat-sidebar')?.classList.add('mobile-hidden');
        document.querySelector('.chat-main')?.classList.add('mobile-chat-open');
        const box = document.getElementById('chatMessages'); box.innerHTML = '<div style="display:flex;justify-content:center;padding:32px;"><div class="spinner"></div></div>';
        await maintain(gid);                                      // keys first, so history can be read at once
        if (S.cur?.id !== gid) return;
        const m = await api('GET', `/api/groups/${gid}/messages?limit=100`);
        if (S.cur?.id !== gid) return;
        S.msgs = m.d.messages || [];
        await decryptAll(); render();
        document.getElementById('chatInput')?.focus();
    }
    async function decryptOne(m) {
        if (m.id in S.plain) return;
        const t = await open(m.group_id || S.cur.id, m.sender_id, m.encrypted_content ?? m.content);
        if (t === null) return;                                   // stays locked; retried after keys arrive
        S.plain[m.id] = t;
        if (m.message_type === 'document') chat._plainData[m.id] = t;   // lets the shared file / photo / voice code open it
    }
    async function decryptAll() { for (const m of S.msgs) await decryptOne(m); }

    function render() {
        const box = document.getElementById('chatMessages'); if (!box || !S.cur) return;
        if (!S.msgs.length) {
            box.innerHTML = `<div class="chat-welcome"><i class="fas fa-users"></i><h3>${esc(S.cur.name)}</h3><p>Messages and files here are end-to-end encrypted. Only the ${S.cur.member_count} people in this group can read them.</p></div>`;
            return;
        }
        const admin = S.cur.role === 'admin'; let html = '', last = '';
        for (const m of S.msgs) {
            const mine = m.sender_id === me, d = new Date(m.created_at).toLocaleDateString();
            if (d !== last) { last = d; html += `<div class="msg-date-sep"><span>${chat._formatDate(m.created_at)}</span></div>`; }
            const text = S.plain[m.id], locked = text === undefined;
            let body = '';
            if (m.message_type === 'document') {
                const note = !locked && window.GhostDocs?.readNote(text);
                if (note && note.kind !== 'file') body = `<div class="msg-enc-media" data-mid="${esc(m.id)}" data-kind="${note.kind}"><span class="msg-enc-loading"><i class="fas fa-lock"></i> Decrypting…</span></div>`;
                else if (note) body = `<button type="button" class="msg-doc-card" onclick="window.chat.downloadDocument('${esc(m.id)}')" title="Decrypt and save"><i class="fas ${window.GhostDocs.iconFor(note.name)}"></i><span class="msg-doc-info"><b>${esc(note.name)}</b><small>${window.GhostDocs.prettySize(note.size)} · tap to decrypt &amp; save</small></span><i class="fas fa-download"></i></button>`;
                else body = `<div class="msg-doc-card locked"><i class="fas fa-lock"></i><span class="msg-doc-info"><b>Encrypted file</b><small>This device does not have the group key for it</small></span></div>`;
            } else body = locked ? `<span class="gg-locked">🔒 Can't be opened on this device (sent before you joined, or the key is missing)</span>` : esc(text);
            const canDel = mine || admin;
            html += `<div class="msg-wrapper ${mine ? 'mine' : 'theirs'}" id="msg-${esc(m.id)}"><div class="msg-bubble ${mine ? 'bubble-mine' : 'bubble-theirs'}">
              ${mine ? '' : `<div class="gg-sender" style="color:hsl(${[...String(m.sender_id)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360},70%,65%)">${esc(m.sender || 'Member')}</div>`}
              <div class="msg-content">${body}</div>
              <div class="msg-meta"><span class="msg-time">${chat._formatTime(m.created_at)}</span></div>
              ${canDel ? `<button class="gg-del" title="Delete for everyone" aria-label="Delete message" data-del="${esc(m.id)}"><i class="fas fa-trash"></i></button>` : ''}
            </div></div>`;
        }
        box.innerHTML = html;
        box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => delMsg(b.dataset.del)));
        chat._scrollToBottom();
    }

    // ── sending ─────────────────────────────────────────────────────────────────
    async function ready() {
        if (!S.cur) return false;
        if (S.cur.rekey_needed || !(await newestLocal(S.cur.id, S.cur.key_version))) await maintain(S.cur.id);
        if (!(await newestLocal(S.cur.id, S.cur.key_version))) { toast('The group key is not ready on this device yet. Please try again in a moment.', 'error'); return false; }
        return true;
    }
    async function sendText() {
        const inp = document.getElementById('chatInput'), text = (inp?.value || '').trim();
        if (!text || !S.cur) return;
        if (!(await ready())) return;
        const s = await seal(S.cur.id, text); if (!s.ok) { toast('Could not encrypt the message', 'error'); return; }
        const r = await api('POST', `/api/groups/${S.cur.id}/messages`, { content: s.packet });
        if (!r.ok) { toast(r.d.error || 'Message was not sent', 'error'); return; }
        inp.value = ''; inp.style.height = 'auto';
        // the live event brings the message back to everyone, including this device
    }
    async function sendFile(file, kind) {
        if (!S.cur) return;
        if (!(await ready())) return;
        const gid = S.cur.id, label = { file: 'document', image: 'photo', audio: 'voice note', video: 'video' }[kind] || 'file';
        toast(`Encrypting ${label}…`, 'info');
        const sealed = await window.GhostDocs.sealWith(file, t => seal(gid, t), kind);
        if (!sealed.ok) { toast(sealed.error || `Could not send the ${label}`, 'error'); return; }
        const f = new FormData(); f.append('file', sealed.file, 'document.bin'); f.append('media_type', 'document'); f.append('caption', sealed.packet);
        const r = await api('POST', `/api/groups/${gid}/media`, f);
        toast(r.ok ? `${label[0].toUpperCase()}${label.slice(1)} sent (encrypted)` : (r.d.error || `Failed to send the ${label}`), r.ok ? 'success' : 'error');
    }
    async function delMsg(id) {
        if (!confirm('Delete this message for everyone in the group?')) return;
        const r = await api('DELETE', `/api/groups/${S.cur.id}/messages/${id}`);
        if (!r.ok) toast(r.d.error || 'Could not delete', 'error');
    }

    // ── live events ─────────────────────────────────────────────────────────────
    async function onMessage(p) {
        const row = S.groups.find(g => g.id === p.group_id);
        if (row) row.last_message_at = p.created_at;
        if (S.cur?.id === p.group_id) {
            if (S.msgs.some(x => x.id === p.id)) return;
            const m = { ...p, encrypted_content: p.content };
            S.msgs.push(m); await decryptOne(m); render();
        } else if (p.sender_id !== me) { S.unread[p.group_id] = (S.unread[p.group_id] || 0) + 1; }
        S.groups.sort((a, b) => (b.last_message_at || b.created_at || '').localeCompare(a.last_message_at || a.created_at || ''));
        paintList();
    }
    async function onUpdated(p) {
        await loadList();
        if (!S.groups.some(g => g.id === p.group_id)) return;
        await maintain(p.group_id);
        if (S.cur?.id === p.group_id) { await decryptAll(); paintHeader(); render(); if (document.getElementById('ggInfo')) openInfo(); }
        paintList();
    }
    function onRemoved(p) {
        if (S.cur?.id === p.group_id) {
            exitView(); document.getElementById('chatWindow').style.display = 'none'; document.getElementById('chatEmptyState').style.display = 'flex';
            document.querySelector('.chat-main')?.classList.remove('mobile-chat-open'); document.querySelector('.chat-sidebar')?.classList.remove('mobile-hidden');
            document.getElementById('ggInfo')?.remove();
            toast('You are no longer in that group', 'info');
        }
        loadList();
    }
    function onDeleted(p) {
        S.msgs = S.msgs.filter(m => m.id !== p.message_id); delete S.plain[p.message_id];
        if (S.cur) render();
    }

    // ── dialogs ─────────────────────────────────────────────────────────────────
    function modal(id, html) {
        document.getElementById(id)?.remove(); css();
        const m = document.createElement('div'); m.className = 'gg-modal'; m.id = id; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true');
        m.innerHTML = `<div class="gg-card">${html}</div>`;
        m.addEventListener('click', e => { if (e.target === m) m.remove(); });
        m.addEventListener('keydown', e => { if (e.key === 'Escape') m.remove(); });
        document.body.appendChild(m); return m;
    }
    const contactsAvail = (exclude = []) => (chat.contacts || []).filter(c => !c.is_blocked && !exclude.includes(c.contact_id));

    function openCreate() {
        const list = contactsAvail();
        const m = modal('ggCreate', `<h3><i class="fas fa-users"></i> New group</h3>
          <label for="ggName">Group name</label><input type="text" id="ggName" maxlength="60" placeholder="e.g. Project team" autocomplete="off" />
          <label>Add people from your contacts</label>
          <div class="gg-pick">${list.length ? list.map(c => `<label><input type="checkbox" value="${esc(c.contact_id)}"> <span>${esc(c.display_name || c.username)}</span></label>`).join('') : '<div class="gg-empty" style="padding:14px">You have no contacts to add yet.</div>'}</div>
          <p class="gg-note"><i class="fas fa-lock"></i> The group key is made on your device and given to each person, encrypted for them. We never see it. Up to 50 people.</p>
          <div class="gg-row"><button class="gg-btn" type="button" id="ggCancel">Cancel</button><button class="gg-btn pri" type="button" id="ggGo">Create group</button></div>`);
        m.querySelector('#ggCancel').onclick = () => m.remove();
        m.querySelector('#ggName').focus();
        m.querySelector('#ggGo').onclick = async () => {
            const name = m.querySelector('#ggName').value.trim(), ids = [...m.querySelectorAll('.gg-pick input:checked')].map(x => x.value);
            if (!name) { toast('Give the group a name', 'error'); return; }
            if (!ids.length) { toast('Pick at least one person', 'error'); return; }
            const b = m.querySelector('#ggGo'); b.disabled = true; b.textContent = 'Creating…';
            const r = await api('POST', '/api/groups', { name, member_ids: ids });
            if (!r.ok) { toast(r.d.error || 'Could not create the group', 'error'); b.disabled = false; b.textContent = 'Create group'; return; }
            m.remove(); await loadList(); await openGroup(r.d.group.id);
        };
    }

    function openInfo() {
        if (!S.cur) return;
        const g = S.cur, admin = g.role === 'admin';
        const m = modal('ggInfo', `<h3><i class="fas fa-users"></i> <span id="ggTitle"></span></h3>
          ${admin ? `<label for="ggRename">Group name</label><div style="display:flex;gap:8px"><input type="text" id="ggRename" maxlength="60" /><button class="gg-btn" id="ggSaveName" type="button">Save</button></div>` : ''}
          <label>${g.member_count} people</label>
          <div class="gg-pick" style="max-height:260px">${g.members.map(x => `<div class="gg-mem"><span class="nm">${esc(x.username)}${x.user_id === me ? ' (you)' : ''}</span>${x.role === 'admin' ? '<span class="gg-tag">admin</span>' : ''}${admin && x.user_id !== me ? `<button class="gg-x" data-rm="${esc(x.user_id)}" title="Remove from group" aria-label="Remove ${esc(x.username)}"><i class="fas fa-user-minus"></i></button>` : ''}</div>`).join('')}</div>
          ${admin ? `<label>Add people</label><div class="gg-pick" id="ggAddBox" style="max-height:160px">${(() => { const l = contactsAvail(g.members.map(x => x.user_id)); return l.length ? l.map(c => `<div class="gg-mem"><span class="nm">${esc(c.display_name || c.username)}</span><button class="gg-btn" data-add="${esc(c.contact_id)}" type="button">Add</button></div>`).join('') : '<div class="gg-empty" style="padding:12px">Everyone in your contacts is already here.</div>'; })()}</div>` : ''}
          <p class="gg-note"><i class="fas fa-key"></i> Key version ${g.key_version}. When someone joins or leaves, a new key is made automatically. People who left can't read new messages, and new people can't read old ones.</p>
          <div class="gg-row">${admin ? '<button class="gg-btn" id="ggRotate" type="button" title="Make a fresh group key now">Change key</button><button class="gg-btn bad" id="ggDelete" type="button">Delete group</button>' : ''}<button class="gg-btn bad" id="ggLeave" type="button">Leave group</button><button class="gg-btn pri" id="ggClose" type="button">Done</button></div>`);
        m.querySelector('#ggTitle').textContent = g.name;
        const rn = m.querySelector('#ggRename'); if (rn) rn.value = g.name;
        m.querySelector('#ggClose').onclick = () => m.remove();
        const after = async r => { if (!r.ok) { toast(r.d.error || 'That did not work', 'error'); return false; } return true; };
        m.querySelector('#ggSaveName')?.addEventListener('click', async () => { const n = rn.value.trim(); if (n && await after(await api('PUT', `/api/groups/${g.id}`, { name: n }))) { await refreshCur(); } });
        m.querySelectorAll('[data-rm]').forEach(b => b.onclick = async () => { if (confirm('Remove this person from the group?') && await after(await api('DELETE', `/api/groups/${g.id}/members/${b.dataset.rm}`))) { await maintain(g.id); await refreshCur(); } });
        m.querySelectorAll('[data-add]').forEach(b => b.onclick = async () => { b.disabled = true; if (await after(await api('POST', `/api/groups/${g.id}/members`, { user_id: b.dataset.add }))) { await maintain(g.id); await refreshCur(); } else b.disabled = false; });
        m.querySelector('#ggRotate')?.addEventListener('click', async () => { await maintain(g.id, true); toast('Group key changed', 'success'); await refreshCur(); });
        m.querySelector('#ggLeave').onclick = async () => { if (confirm('Leave this group? You will lose access to its messages.') && await after(await api('POST', `/api/groups/${g.id}/leave`))) { m.remove(); onRemoved({ group_id: g.id }); } };
        m.querySelector('#ggDelete')?.addEventListener('click', async () => { if (confirm('Delete this group and all its messages for everyone? This cannot be undone.') && await after(await api('DELETE', `/api/groups/${g.id}`))) { m.remove(); onRemoved({ group_id: g.id }); } });
    }
    async function refreshCur() {
        if (!S.cur) return; const r = await api('GET', `/api/groups/${S.cur.id}`); if (r.ok) { S.cur = r.d.group; paintHeader(); }
        await loadList(); if (document.getElementById('ggInfo')) openInfo();
    }

    // ── hook into the chat page ─────────────────────────────────────────────────
    function patch() {
        const P = window.GhostChatRealtime.prototype;
        const wrap = (name, fn) => { const o = P[name]; P[name] = function (...a) { return S.cur ? fn.apply(this, a) : o.apply(this, a); }; };
        wrap('sendMessage', () => sendText());
        wrap('_uploadMedia', (file, kind) => sendFile(file, ['image', 'audio', 'video'].includes(kind) ? kind : 'file'));
        wrap('_sendDocument', file => sendFile(file, 'file'));
        wrap('_handleTyping', () => {});
        const oo = P.openChat; P.openChat = function (...a) { exitView(); return oo.apply(this, a); };
    }
    async function boot() {
        chat = window.chat; me = String(chat.user.id);
        if (!window.GhostE2E || !subtle || !window.GhostChatRealtime) return;
        patch();
        ensureSection(); await loadList();
        document.getElementById('mobileBackBtn')?.addEventListener('click', exitView);
        const wait = setInterval(() => {
            if (!chat.socket) return; clearInterval(wait);
            chat.socket.on('group_message', onMessage); chat.socket.on('group_updated', onUpdated);
            chat.socket.on('group_removed', onRemoved); chat.socket.on('group_message_deleted', onDeleted);
            chat.socket.on('connect', () => { loadList(); });
        }, 300);
        // quietly finish any key changes that are due, one group at a time
        for (const g of S.groups) if (g.rekey_needed || !g.key_version) maintain(g.id);
        window.addEventListener('ghoste2e:changed', async () => { for (const g of S.groups) await maintain(g.id); if (S.cur) { await decryptAll(); render(); } });
    }
    const start = () => {
        const t0 = Date.now(), iv = setInterval(() => {
            if (window.chat?.user?.id && window.GhostChatRealtime) { clearInterval(iv); boot().catch(e => console.warn('[groups] start-up', e)); }
            else if (Date.now() - t0 > 15000) clearInterval(iv);
        }, 250);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

    window.GhostGroups = { state: S, openGroup, loadList, maintain, openCreate, openInfo };
})();
