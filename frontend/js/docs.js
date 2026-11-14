/**
 * GHOSTCHAT ATTACHMENTS  v2   (documents, photos, voice notes, video)
 * End-to-end encrypted files, for one-to-one chats and groups.
 *
 *  1. A fresh random AES-256-GCM key is made for EVERY file.
 *  2. The file is encrypted in the browser. Only ciphertext is uploaded.
 *  3. The file's name, type, size, kind and that key go inside a small note, which is
 *     encrypted with the chat's end-to-end key (a pair's key, or a group's key).
 *  4. The receiver opens the note, gets the key, downloads the ciphertext, decrypts it
 *     in the browser, and shows or saves it.
 *
 * The server never sees the file, its name, its kind, or the key. It cannot scan files for
 * viruses either, so documents are limited to common safe types, nothing that can run code
 * is accepted, and decrypted files are only ever shown as plain images / audio / video
 * (from an allowed list of formats) or saved as opaque downloads.
 */
window.GhostDocs = (() => {
    const KIND_LIMIT = { file: 20, image: 8, audio: 15, video: 40 };          // MB
    const MAX_BYTES = KIND_LIMIT.file * 1048576;
    const ALLOWED = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'txt', 'csv', 'rtf',
        'md', 'json', 'xml', 'zip', '7z', 'rar', 'tar', 'gz', 'epub']);
    const MEDIA_MIMES = {
        image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
        audio: ['audio/webm', 'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'audio/mp3'],
        video: ['video/mp4', 'video/webm', 'video/quicktime'],
    };
    const AAD = new TextEncoder().encode('gcdoc1');
    const subtle = (globalThis.crypto || {}).subtle;

    const b64 = buf => { let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s); };
    const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
    const extOf = name => { const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; };
    const baseMime = t => String(t || '').split(';')[0].trim().toLowerCase();

    function safeName(name) {
        let n = String(name || 'document').normalize('NFKC')
            .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, '')
            .replace(/[\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').trim();
        if (n.length > 120) { const e = extOf(n); n = n.slice(0, 110) + (e ? '.' + e : ''); }
        return n || 'document';
    }

    function check(file, kind = 'file') {
        if (!file) return 'No file chosen';
        if (!file.size) return 'That file is empty';
        const lim = KIND_LIMIT[kind] || KIND_LIMIT.file;
        if (file.size > lim * 1048576) return `${kind === 'file' ? 'Documents' : kind[0].toUpperCase() + kind.slice(1) + 's'} must be under ${lim} MB`;
        if (kind === 'file') {
            const e = extOf(file.name);
            if (!ALLOWED.has(e)) return e ? `".${e}" files are not allowed for safety. Allowed: PDF, Word, Excel, PowerPoint, text, CSV and ZIP.` : 'This file type is not allowed';
        } else if (!MEDIA_MIMES[kind].includes(baseMime(file.type))) {
            return `That ${kind} format is not supported`;
        }
        return null;
    }

    // `enc(text)` → Promise<{ok, packet, reason?, mode?}> encrypts the note for this chat (pair or group).
    async function sealWith(file, enc, kind = 'file') {
        const problem = check(file, kind);
        if (problem) return { ok: false, error: problem };
        if (!subtle) return { ok: false, error: 'Encryption is not available in this browser' };
        const key = crypto.getRandomValues(new Uint8Array(32));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const aes = await subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
        const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, aes, await file.arrayBuffer()));
        const note = JSON.stringify({ v: 1, c: kind, n: safeName(file.name || kind), t: baseMime(file.type).slice(0, 100), s: file.size, k: b64(key) });
        const r = await enc(note);
        if (!r.ok) return { ok: false, reason: r.reason, mode: r.mode, error: 'Encryption is not ready for this chat' };
        const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
        return { ok: true, packet: r.packet, file: new File([out], 'document.bin', { type: 'application/octet-stream' }) };
    }
    // One-to-one convenience
    function seal(file, contactId, kind = 'file') {
        if (!window.GhostE2E) return Promise.resolve({ ok: false, error: 'Encryption is not available in this browser' });
        return sealWith(file, text => window.GhostE2E.encryptFor(contactId, text), kind);
    }

    function readNote(json) {
        try {
            const o = JSON.parse(json);
            if (!o || o.v !== 1 || typeof o.k !== 'string') return null;
            const kind = ['image', 'audio', 'video'].includes(o.c) ? o.c : 'file';
            return { kind, name: safeName(o.n), type: baseMime(o.t), size: +o.s || 0, key: o.k };
        } catch (_) { return null; }
    }

    async function fetchPlain(note, url) {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(res.status === 404 ? 'This file is no longer available' : 'Could not download the file');
        const raw = new Uint8Array(await res.arrayBuffer());
        if (raw.length < 29) throw new Error('The file is damaged');
        try {
            const aes = await subtle.importKey('raw', unb64(note.key), 'AES-GCM', false, ['decrypt']);
            return await subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12), additionalData: AAD }, aes, raw.slice(12));
        } catch (_) { throw new Error('This file was changed or is damaged, so it was not opened'); }
    }
    function saveBlob(blob, name) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob); a.download = name; a.rel = 'noopener'; a.style.display = 'none';
        document.body.appendChild(a); a.click();
        setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    }
    // Save as a download (documents, or "save" on a photo/voice note/video).
    async function open(note, url) {
        if (note.kind === 'file' && !ALLOWED.has(extOf(note.name))) throw new Error('This file type is blocked for your safety');
        const plain = await fetchPlain(note, url);
        saveBlob(new Blob([plain], { type: 'application/octet-stream' }), note.name);
        return true;
    }
    // Decrypt a photo / voice note / video for showing in the page. Returns a blob: URL.
    async function show(note, url) {
        if (!MEDIA_MIMES[note.kind] || !MEDIA_MIMES[note.kind].includes(note.type)) throw new Error('This format cannot be shown here. Use Save.');
        const plain = await fetchPlain(note, url);
        return URL.createObjectURL(new Blob([plain], { type: note.type }));
    }

    const prettySize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
    const iconFor = name => ({ pdf: 'fa-file-pdf', doc: 'fa-file-word', docx: 'fa-file-word', xls: 'fa-file-excel', xlsx: 'fa-file-excel', csv: 'fa-file-csv',
        ppt: 'fa-file-powerpoint', pptx: 'fa-file-powerpoint', zip: 'fa-file-zipper', '7z': 'fa-file-zipper', rar: 'fa-file-zipper', gz: 'fa-file-zipper', tar: 'fa-file-zipper',
        txt: 'fa-file-lines', md: 'fa-file-lines', rtf: 'fa-file-lines' }[extOf(name)] || 'fa-file');

    return { MAX_BYTES, KIND_LIMIT, ALLOWED, MEDIA_MIMES, check, seal, sealWith, readNote, open, show, saveBlob, safeName, prettySize, iconFor, extOf, baseMime };
})();
