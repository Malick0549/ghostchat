/**
 * GHOSTCHAT E2E MODULE  v2
 * End-to-end encryption in the browser (WebCrypto). Two modes, chosen in
 * Settings (global default) and overridable per contact:
 *
 *  AUTOMATIC  Each device makes an ECDH P-256 key pair; the server only holds
 *             PUBLIC keys. Both people derive the same AES-256-GCM key.
 *             Packet:  "🔐E2E1:" + base64(iv || ciphertext)
 *
 *  MANUAL     You and your contact set the key yourselves, by one of:
 *               - dh      Diffie-Hellman: swap public codes (QR / paste)
 *               - random  a random 256-bit key shared by QR / text
 *               - pass    a typed passphrase stretched with PBKDF2 (600k)
 *             Keys live on this device (IndexedDB). Optional encrypted backup.
 *             Packet:  "🔐E2E2:" + keyId + ":" + base64(iv || ciphertext)
 *
 * No key or passphrase is ever sent to the server in plain form. For manual
 * mode the server only learns a short key ID (an HMAC tag) so each side can
 * tell whether the other has the SAME key before a message is sent.
 */
window.GhostE2E = (() => {
    const P1 = '🔐E2E1:', P2 = '🔐E2E2:';
    const VAULT_ITER = 600000;
    const enc = new TextEncoder(), dec = new TextDecoder();
    const subtle = (globalThis.crypto || {}).subtle;
    const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

    let _base = '', _csrf = () => '', _me = null;
    let _autoP = null;                         // lazy automatic-key setup
    let _priv = null, _pubJwk = null;
    const _convKeys = new Map();               // automatic conversation keys
    const _statusCache = new Map();            // manual readiness cache
    let onKeyChange = null;
    let _ttl = 5000;                           // how long a 'ready' answer is trusted (ms)

    // ── helpers ──────────────────────────────────────────────────────────────
    const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
    const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const b64u = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const unb64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); return unb64(s + '='.repeat((4 - s.length % 4) % 4)); };
    const hex = u => [...new Uint8Array(u)].map(b => b.toString(16).padStart(2, '0')).join('');
    const sortedIds = (a, b) => [String(a), String(b)].sort();
    const emit = (cid) => {
        _statusCache.clear();
        try { if (typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('ghoste2e:changed', { detail: { contactId: cid } })); } catch (_) {}
    };

    async function api(method, path, body) {
        try {
            const res = await fetch(`${_base}${path}`, {
                method, credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': _csrf() },
                body: body ? JSON.stringify(body) : undefined,
            });
            let data = {}; try { data = await res.json(); } catch (_) {}
            return { ok: res.ok, status: res.status, data };
        } catch (_) { return { ok: false, status: 0, data: {}, network: true }; }
    }

    // ── IndexedDB ────────────────────────────────────────────────────────────
    function idb() {
        return new Promise((resolve, reject) => {
            const r = indexedDB.open('ghostchat-e2e', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('keys');
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }
    async function idbGet(k) { const d = await idb(); return new Promise((res, rej) => { const q = d.transaction('keys').objectStore('keys').get(k); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }
    async function idbPut(k, v) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('keys', 'readwrite'); t.objectStore('keys').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
    async function idbDel(k) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('keys', 'readwrite'); t.objectStore('keys').delete(k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }
    async function idbKeys() { const d = await idb(); return new Promise((res, rej) => { const q = d.transaction('keys').objectStore('keys').getAllKeys(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); }

    // ── preferences (mode) ───────────────────────────────────────────────────
    const prefKey = () => `gc_e2e_prefs_${_me}`;
    function prefs() {
        try {
            const p = JSON.parse(localStorage.getItem(prefKey()) || 'null') || {};
            return { default: p.default === 'manual' ? 'manual' : 'auto', overrides: p.overrides && typeof p.overrides === 'object' ? p.overrides : {} };
        } catch (_) { return { default: 'auto', overrides: {} }; }
    }
    function savePrefs(p) { try { localStorage.setItem(prefKey(), JSON.stringify(p)); } catch (_) {} }
    const getDefault = () => prefs().default;
    const getOverride = cid => { const o = prefs().overrides[cid]; return o === 'auto' || o === 'manual' ? o : null; };
    const getMode = cid => getOverride(cid) || prefs().default;
    function setDefault(m) { const p = prefs(); p.default = m === 'manual' ? 'manual' : 'auto'; savePrefs(p); emit(null); }
    function setOverride(cid, m) { const p = prefs(); if (m === 'auto' || m === 'manual') p.overrides[cid] = m; else delete p.overrides[cid]; savePrefs(p); emit(cid); }

    // ── vault (password-locked backup blob) ──────────────────────────────────
    async function passKey(pass, salt, iter) {
        const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
        return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    }
    async function makeVault(obj, pass) {
        const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
        const k = await passKey(pass, salt, VAULT_ITER);
        const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode(JSON.stringify(obj)));
        return { v: 1, iter: VAULT_ITER, salt: b64(salt), iv: b64(iv), data: b64(ct) };
    }
    async function openVault(vault, pass) {
        const k = await passKey(pass, unb64(vault.salt), vault.iter);
        return JSON.parse(dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, k, unb64(vault.data))));
    }

    // ══ AUTOMATIC MODE ═══════════════════════════════════════════════════════
    const cleanJwk = j => ({ kty: 'EC', crv: 'P-256', x: j.x, y: j.y });
    const importPrivate = jwk => subtle.importKey('jwk', jwk, ECDH, false, ['deriveBits']);

    async function _setupAuto() {
        if (!subtle) return false;
        const slot = `me:${_me}`;
        const saved = await idbGet(slot);
        if (saved && saved.priv && saved.pub) {
            _priv = saved.priv; _pubJwk = saved.pub;
        } else {
            const v = await api('GET', '/api/keys/vault');
            if (v.ok && v.data.vault) {
                for (let tries = 0; tries < 3 && !_priv; tries++) {
                    const pass = prompt('Enter your GhostChat recovery passphrase to unlock your secure messages on this device:');
                    if (!pass) break;
                    try {
                        const privJwk = await openVault(v.data.vault, pass);
                        _priv = await importPrivate(privJwk); _pubJwk = cleanJwk(privJwk);
                    } catch (_) { alert('Wrong passphrase.'); }
                }
                if (!_priv && confirm('Create NEW secure-message keys instead?\n\nOld automatic-mode messages will no longer be readable.')) await _createAuto();
            } else {
                await _createAuto();
            }
            if (_priv) await idbPut(slot, { priv: _priv, pub: _pubJwk });
        }
        if (!_priv) return false;
        const mine = await api('GET', `/api/keys/${_me}`);
        if (!mine.ok || !mine.data.public_key || mine.data.public_key.x !== _pubJwk.x || mine.data.public_key.y !== _pubJwk.y) {
            await api('PUT', '/api/keys/public', { public_key: _pubJwk });
        }
        return true;
    }
    async function _createAuto() {
        const pair = await subtle.generateKey(ECDH, true, ['deriveBits']);
        const privJwk = await subtle.exportKey('jwk', pair.privateKey);
        _pubJwk = cleanJwk(await subtle.exportKey('jwk', pair.publicKey));
        _priv = await importPrivate(privJwk);
        let pass = prompt('Create a RECOVERY PASSPHRASE (8+ characters).\nIt lets you read your secure messages on another phone or computer.\nWrite it down: nobody, including GhostChat, can recover it for you.');
        while (pass != null && pass.length < 8) pass = prompt('Passphrase must be at least 8 characters:');
        const vault = pass ? await makeVault(privJwk, pass) : null;
        await api('PUT', '/api/keys/public', { public_key: _pubJwk, vault, reset: true });
    }
    const ensureAuto = () => (_autoP || (_autoP = _setupAuto().catch(e => { console.warn('E2E auto setup failed', e); return false; })));

    async function _fingerprint(jwkA, jwkB) {
        const parts = [jwkA, jwkB].map(j => j.x + j.y).sort().join('|');
        const h = new Uint8Array(await subtle.digest('SHA-256', enc.encode(parts)));
        return hex(h).slice(0, 30).match(/.{1,5}/g).join(' ');
    }
    async function _convKey(cid) {
        if (!(await ensureAuto()) || !_priv) return null;
        const r = await api('GET', `/api/keys/${cid}`);
        const theirs = r.ok && r.data.public_key;
        if (!theirs) { _convKeys.delete(cid); return null; }
        const cached = _convKeys.get(cid);
        if (cached && cached.x === theirs.x && cached.y === theirs.y) return cached;
        const pub = await subtle.importKey('jwk', cleanJwk(theirs), ECDH, false, []);
        const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, _priv, 256);
        const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
        const ids = sortedIds(_me, cid);
        const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('ghostchat-e2e-v1'), info: enc.encode(ids.join('|')) }, hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const fp = await _fingerprint(_pubJwk, theirs);
        const entry = { key, fp, x: theirs.x, y: theirs.y, aad: enc.encode('gce2e1|' + ids.join('|')) };
        try {
            const mk = `gc_e2e_fp_${_me}_${cid}`, old = localStorage.getItem(mk);
            if (old && old !== fp && typeof onKeyChange === 'function') onKeyChange(cid);
            localStorage.setItem(mk, fp);
        } catch (_) {}
        _convKeys.set(cid, entry);
        return entry;
    }
    async function encAuto(cid, text) {
        const k = await _convKey(cid);
        if (!k) return { ok: false, reason: _priv ? 'peer_not_ready' : 'no_auto_key', mode: 'auto' };
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: k.aad }, k.key, enc.encode(text)));
        const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
        return { ok: true, packet: P1 + b64(out), mode: 'auto' };
    }

    // ══ MANUAL MODE ══════════════════════════════════════════════════════════
    const mKey = cid => `manual:${_me}:${cid}`;
    const loadManual = async cid => (await idbGet(mKey(cid))) || { keys: [], active: null };
    const saveManual = (cid, rec) => idbPut(mKey(cid), rec);
    const aesFromRaw = raw => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

    async function kidOf(raw) {
        const h = await subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        return hex(new Uint8Array(await subtle.sign('HMAC', h, enc.encode('ghostchat-kid-v1'))).slice(0, 8));
    }
    async function publishStatus(cid, kid) {
        await api('PUT', '/api/keys/manual-status', { contact_id: cid, kid: kid || null });
    }
    async function addKey(cid, rawBytes, method) {
        const raw = new Uint8Array(rawBytes);
        if (raw.length !== 32) throw new Error('Key must be 256 bits');
        const kid = await kidOf(raw);
        const rec = await loadManual(cid);
        if (!rec.keys.some(k => k.kid === kid)) rec.keys.push({ kid, raw: b64(raw), method, created: Date.now() });
        rec.active = kid;
        await saveManual(cid, rec);
        await publishStatus(cid, kid);
        emit(cid);
        return kid;
    }

    // readiness: does the contact hold the SAME key as me?
    async function manualStatus(cid, force) {
        const rec = await loadManual(cid);
        const hasKey = !!rec.active;
        if (!hasKey) return { hasKey: false, state: 'no_key', mine: null, theirs: null };
        const c = _statusCache.get(cid);
        if (!force && c && Date.now() - c.t < _ttl && c.mine === rec.active) return c.v;
        const r = await api('GET', `/api/keys/manual-status/${cid}`);
        let v;
        if (r.ok) {
            const theirs = r.data.theirs || null;
            v = { hasKey: true, mine: rec.active, theirs, state: !theirs ? 'waiting' : (theirs === rec.active ? 'ready' : 'mismatch') };
            // remember only "ready": a "waiting"/"mismatch" answer must be re-checked every time,
            // otherwise the sender stays blocked after the contact finishes setting up
            if (v.state === 'ready') _statusCache.set(cid, { t: Date.now(), mine: rec.active, v });
            else _statusCache.delete(cid);
        } else if (c && c.mine === rec.active && c.v.state === 'ready' && Date.now() - c.t < 600000) {
            v = c.v;                                          // brief network loss: keep last known good
        } else {
            v = { hasKey: true, mine: rec.active, theirs: null, state: 'unknown' };
        }
        return v;
    }
    async function encManual(cid, text) {
        const st = await manualStatus(cid);
        // 'unknown' = the server could not be reached. The message is encrypted with my key either way,
        // so keep sending (it queues offline) instead of blocking on a weak network.
        if (st.state !== 'ready' && st.state !== 'unknown') return { ok: false, reason: st.state === 'no_key' ? 'no_manual_key' : st.state === 'waiting' ? 'peer_not_ready' : 'key_mismatch', mode: 'manual' };
        const rec = await loadManual(cid);
        const entry = rec.keys.find(k => k.kid === rec.active);
        const aes = await aesFromRaw(unb64(entry.raw));
        const aad = enc.encode(`gce2e2|${entry.kid}|` + sortedIds(_me, cid).join('|'));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, aes, enc.encode(text)));
        const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
        return { ok: true, packet: `${P2}${entry.kid}:${b64(out)}`, mode: 'manual' };
    }

    // ── manual setup methods ────────────────────────────────────────────────
    async function dhStart(cid) {
        const slot = `dh:${_me}:${cid}`;
        let p = await idbGet(slot);
        if (!p) {
            const pair = await subtle.generateKey(ECDH, false, ['deriveBits']);
            const j = await subtle.exportKey('jwk', pair.publicKey);
            p = { priv: pair.privateKey, x: j.x, y: j.y, created: Date.now() };
            await idbPut(slot, p);
        }
        const bytes = new Uint8Array(64); bytes.set(unb64u(p.x), 0); bytes.set(unb64u(p.y), 32);
        return { share: 'GCDH1.' + b64u(bytes) };
    }
    async function importCode(cid, text) {
        text = String(text || '').trim().replace(/\s+/g, '');
        if (text.startsWith('GCDH1.')) return dhFinish(cid, text);
        if (text.startsWith('GCKEY1.')) {
            let raw; try { raw = unb64u(text.slice(7)); } catch (_) { throw new Error('That code is damaged. Copy it again.'); }
            if (raw.length !== 32) throw new Error('That code is not a valid key.');
            const kid = await addKey(cid, raw, 'random');
            return { kind: 'random', kid };
        }
        throw new Error('That is not a GhostChat code. It should start with GCDH1. or GCKEY1.');
    }
    async function dhFinish(cid, text) {
        let theirs;
        try { theirs = unb64u(text.slice(6)); } catch (_) { throw new Error('That code is damaged. Copy it again.'); }
        if (theirs.length !== 64) throw new Error('That code is not valid.');
        const slot = `dh:${_me}:${cid}`;
        const mine = await idbGet(slot);
        if (!mine) throw new Error('Open "Show my code" first, so your side has a code too.');
        const tj = { kty: 'EC', crv: 'P-256', x: b64u(theirs.slice(0, 32)), y: b64u(theirs.slice(32)) };
        if (tj.x === mine.x && tj.y === mine.y) throw new Error('That is your own code. Paste the one from your contact.');
        let pub; try { pub = await subtle.importKey('jwk', tj, ECDH, false, []); } catch (_) { throw new Error('That code is not a valid key.'); }
        const bits = await subtle.deriveBits({ name: 'ECDH', public: pub }, mine.priv, 256);
        const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveBits']);
        const pubs = [mine.x + mine.y, tj.x + tj.y].sort().join('|');
        const raw = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('ghostchat-manual-dh-v1'), info: enc.encode(sortedIds(_me, cid).join('|') + '|' + pubs) }, hk, 256);
        const kid = await addKey(cid, new Uint8Array(raw), 'dh');
        // NOTE: my code is kept (not rotated) after finishing. The other person may still need to
        // scan/paste it, and it must be the very code I just used, or the two keys would differ.
        return { kind: 'dh', kid, check: await _fingerprint(mine, tj) };
    }
    async function dhReset(cid) {                            // deliberately make NEW codes (re-key)
        await idbDel(`dh:${_me}:${cid}`);
        return dhStart(cid);
    }
    async function randomCreate(cid) {
        const raw = crypto.getRandomValues(new Uint8Array(32));
        const kid = await addKey(cid, raw, 'random');
        return { kid, share: 'GCKEY1.' + b64u(raw) };
    }
    function passStrength(pass) {
        pass = String(pass || '');
        const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pass)).length;
        const words = pass.trim().split(/\s+/).length;
        let score = 0;
        if (pass.length >= 10) score++;
        if (pass.length >= 14) score++;
        if (pass.length >= 20 || words >= 4) score++;
        if (classes >= 3 || words >= 4) score++;
        return { score, ok: pass.length >= 10, label: ['Too weak', 'Weak', 'Fair', 'Good', 'Strong'][score] };
    }
    async function passphrase(cid, pass) {
        const s = passStrength(pass);
        if (!s.ok) throw new Error('Use at least 10 characters. A sentence of 4+ random words is best.');
        const salt = new Uint8Array(await subtle.digest('SHA-256', enc.encode('ghostchat-pass-v1|' + sortedIds(_me, cid).join('|'))));
        const base = await subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
        const raw = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: VAULT_ITER }, base, 256);
        const kid = await addKey(cid, new Uint8Array(raw), 'pass');
        return { kid, strength: s };
    }
    async function manualRetire(cid) {                      // stop using it; old messages stay readable
        const rec = await loadManual(cid); rec.active = null; await saveManual(cid, rec);
        await publishStatus(cid, null); emit(cid);
    }
    async function manualWipe(cid) {                        // erase all manual keys for this contact
        await idbDel(mKey(cid)); await idbDel(`dh:${_me}:${cid}`);
        await publishStatus(cid, null); emit(cid);
    }
    async function manualShare(cid) {                       // code for the active RANDOM key (so it can be shown again)
        const rec = await loadManual(cid);
        const a = rec.keys.find(k => k.kid === rec.active);
        return a && a.method === 'random' ? 'GCKEY1.' + b64u(unb64(a.raw)) : null;
    }
    async function manualInfo(cid) {
        const rec = await loadManual(cid);
        const a = rec.keys.find(k => k.kid === rec.active);
        return { hasKey: !!a, kid: a?.kid || null, method: a?.method || null, count: rec.keys.length };
    }

    // ── backup / restore of manual keys ─────────────────────────────────────
    async function backup(pass) {
        if (!pass || pass.length < 8) throw new Error('Use a backup passphrase of at least 8 characters.');
        const manual = {};
        for (const k of await idbKeys()) {
            if (typeof k === 'string' && k.startsWith(`manual:${_me}:`)) manual[k.split(':').slice(2).join(':')] = await idbGet(k);
        }
        const vault = await makeVault({ v: 1, prefs: prefs(), manual }, pass);
        const r = await api('PUT', '/api/keys/manual-vault', { vault });
        if (!r.ok) throw new Error(r.data.error || 'Could not save the backup. Check your connection.');
        return { contacts: Object.keys(manual).length };
    }
    async function restore(pass) {
        const r = await api('GET', '/api/keys/manual-vault');
        if (!r.ok) throw new Error('Could not reach the server.');
        if (!r.data.vault) throw new Error('No backup found for this account.');
        let data; try { data = await openVault(r.data.vault, pass); } catch (_) { throw new Error('Wrong backup passphrase.'); }
        let n = 0;
        for (const [cid, inc] of Object.entries(data.manual || {})) {
            const rec = await loadManual(cid);
            for (const k of inc.keys || []) if (!rec.keys.some(x => x.kid === k.kid)) { rec.keys.push(k); n++; }
            rec.active = rec.active || inc.active || null;
            await saveManual(cid, rec);
            if (rec.active) await publishStatus(cid, rec.active);
        }
        const p = prefs(), bp = data.prefs || {};
        for (const [cid, m] of Object.entries(bp.overrides || {})) if (!(cid in p.overrides)) p.overrides[cid] = m;
        savePrefs(p);
        emit(null);
        return { keys: n, contacts: Object.keys(data.manual || {}).length };
    }

    // ══ PUBLIC API ═══════════════════════════════════════════════════════════
    async function encryptFor(cid, text) {
        const mode = getMode(cid);
        try { return mode === 'manual' ? await encManual(cid, text) : await encAuto(cid, text); }
        catch (e) { console.warn('encrypt failed', e); return { ok: false, reason: 'error', mode }; }
    }
    async function decrypt(cid, packet) {
        if (packet.startsWith(P2)) {
            const rest = packet.slice(P2.length), i = rest.indexOf(':');
            const kid = rest.slice(0, i), raw = unb64(rest.slice(i + 1));
            const rec = await loadManual(cid);
            const entry = rec.keys.find(k => k.kid === kid);
            if (!entry) throw new Error('no key');
            const aes = await aesFromRaw(unb64(entry.raw));
            const aad = enc.encode(`gce2e2|${kid}|` + sortedIds(_me, cid).join('|'));
            return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: aad }, aes, raw.slice(12)));
        }
        const k = await _convKey(cid);
        if (!k) throw new Error('no key');
        const raw = unb64(packet.slice(P1.length));
        return dec.decode(await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: k.aad }, k.key, raw.slice(12)));
    }

    return {
        P1, P2,
        isE2E: s => typeof s === 'string' && (s.startsWith(P1) || s.startsWith(P2)),
        set onKeyChange(fn) { onKeyChange = fn; },
        setStatusTtl(ms) { _ttl = Math.max(0, +ms || 0); },
        bindUser(userId) { _me = String(userId); },          // modes only, no key setup (Settings page)
        init(userId, baseUrl, csrfGetter) {
            _me = String(userId); _base = baseUrl || ''; _csrf = csrfGetter || (() => '');
            _autoP = null; _priv = null; _pubJwk = null; _convKeys.clear(); _statusCache.clear();
            return getDefault() === 'auto' ? ensureAuto() : Promise.resolve(true);
        },
        // mode
        getMode, getDefault, getOverride, setDefault, setOverride,
        // send / receive
        encryptFor, decrypt,
        // status
        manualStatus, manualInfo, manualShare,
        async autoInfo(cid) { const k = await _convKey(cid).catch(() => null); return { ready: !!k, safety: k ? k.fp : null }; },
        async safetyNumber(cid) { const k = await _convKey(cid); return k ? k.fp : null; },
        // manual setup
        dhStart, dhReset, importCode, randomCreate, passphrase, passStrength, manualRetire, manualWipe,
        backup, restore,
    };
})();
