"""Browser test: send-to-user, generated key, paste-to-decrypt, emoji picker. Needs a running server (see SEND_BASE) and the ids it seeds."""
import asyncio, json, os, sys, re
from playwright.async_api import async_playwright
B = os.environ.get('SEND_BASE', 'http://127.0.0.1:5066')
IDS = eval(open(os.environ.get('SEND_IDS', '/tmp/claude-0/ids.txt')).read())
PW = 'Passw0rd!x'; REC = 'Recover-pass-12345'
res = []
def check(n, ok, info=''):
    res.append(bool(ok)); print(('PASS' if ok else 'FAIL'), '-', n, ('' if ok else f'  [{info}]'))

MSG = 'Hello 👋 Ama! Ça va? Me da wo ase 🙏 مرحبا 你好 👨‍👩‍👧 🇬🇭 line2\n"quotes" <b>&amp;</b>'

async def login(br, user, mobile=False):
    ctx = await br.new_context(viewport={'width': 390 if mobile else 1280, 'height': 860}, device_scale_factor=1, is_mobile=mobile, has_touch=mobile)
    pg = await ctx.new_page(); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('dialog', lambda d: asyncio.ensure_future(d.accept(REC) if d.type == 'prompt' else d.accept()))
    t = (await (await ctx.request.get(B + '/api/csrf-token')).json())['csrf_token']
    r = await ctx.request.post(B + '/api/auth/login', data={'username': user, 'password': PW}, headers={'X-CSRF-Token': t})
    assert r.status == 200, r.status
    me = (await (await ctx.request.get(B + '/api/auth/me')).json())['user']
    await pg.goto(B + '/login.html'); await pg.evaluate("u=>localStorage.setItem('ghostchat_user',JSON.stringify(u))", me)
    return ctx, pg, me, errs

async def setup_keys(pg, me):
    await pg.goto(B + '/dashboard.html'); await pg.wait_for_selector('#plaintext', timeout=15000)
    ok = await pg.evaluate("""async id => { GhostE2E.init(id, '', () => (document.cookie.match(/gc_csrf=([^;]+)/)||[])[1]||''); return await GhostE2E.init(id, '', () => (document.cookie.match(/gc_csrf=([^;]+)/)||[])[1]||''); }""", me['id'])
    return ok

async def goto_page(pg, page):
    await pg.goto(B + '/dashboard.html'); await pg.wait_for_selector('.nav-item', timeout=15000)
    await pg.evaluate(f"document.querySelector('.nav-item[data-page={page}]').click()"); await pg.wait_for_selector('#ciphertext' if page == 'decrypt' else '#plaintext', timeout=8000)

async def paste(pg, text):
    await pg.evaluate("t => { const a = document.getElementById('ciphertext'); a.value = t; a.dispatchEvent(new Event('paste', {bubbles:true})); }", text)

async def main():
    async with async_playwright() as p:
        br = await p.chromium.launch()
        cb, pb, bob, eb = await login(br, 'bob'); print('bob keys:', await setup_keys(pb, bob))
        cc, pc, carol, ec = await login(br, 'carol'); print('carol keys:', await setup_keys(pc, carol))
        ca, pa, alice, ea = await login(br, 'alice')

        # ── Encrypt screen and the recipient search ──
        await goto_page(pa, 'encrypt')
        check('mode buttons are shown', await pa.locator('#encModes button').count() == 2)
        await pa.fill('#plaintext', MSG)
        await pa.focus('#recipientSearch'); await pa.wait_for_selector('#recipientResults button', timeout=5000)
        check('focus lists your contacts first', 'bob' in (await pa.inner_text('#recipientResults')))
        await pa.fill('#recipientSearch', 'carol'); await pa.wait_for_selector('#recipientResults button:has-text("carol")', timeout=5000)
        check('typing searches everyone', await pa.locator('#recipientResults button').count() >= 1)
        await pa.click('#recipientResults button:has-text("carol")')
        await pa.wait_for_selector('#recipientHint.ok', timeout=8000)
        check('chosen person shows as ready', 'carol' in (await pa.inner_text('#recipientChosen')))
        await pa.click('#encryptBtn'); await pa.wait_for_selector('#encPacketText', timeout=15000)
        packet = (await pa.inner_text('#encPacketText')).strip()
        check('packet is only emoji (no readable text)', packet and not re.search(r'[A-Za-z0-9]', packet), packet[:60])
        check('result says it is locked for carol', 'carol' in (await pa.inner_text('#encryptResult')))
        check('message is not inside the packet', 'Hello' not in packet)
        print('   packet length (emoji):', len(list(packet)), '(UTF-16 units:', len(packet.encode('utf-16-le')) // 2, ')')

        # ── Carol opens it by pasting; no key typed ──
        await goto_page(pc, 'decrypt'); await paste(pc, packet)
        await pc.wait_for_selector('#decryptResult :text("DECRYPTION SUCCESSFUL")', timeout=15000)
        shown = await pc.evaluate("document.querySelector('#decryptResult div div:last-of-type, #decryptResult').innerText")
        got = await pc.evaluate("[...document.querySelectorAll('#decryptResult div')].map(d=>d.innerText).find(t=>t.includes('Ama'))||''")
        check('carol sees the exact message by pasting (accents, Arabic, Chinese, ZWJ, flag, newline)', MSG in got, got[:120])
        check('password row is hidden for locked messages', await pc.evaluate("document.getElementById('decryptPwRow').hidden"))

        # ── Bob (a different account) cannot open Carol's packet ──
        await goto_page(pb, 'decrypt'); await paste(pb, packet)
        await pb.wait_for_selector('#decryptResult :text("different account")', timeout=15000)
        check('another account is refused with a clear reason', True)
        # ── Sender cannot open it either (nothing readable) ──
        await goto_page(pa, 'decrypt'); await paste(pa, packet)
        await pa.wait_for_selector('#decryptResult :text("different account")', timeout=15000)
        check('sender cannot reopen a packet made for someone else', True)

        # ── Tampered packet is refused, not garbled ──
        chars = list(packet); i = len(chars) // 2; chars[i] = '🌀' if chars[i] != '🌀' else '🌁'
        await goto_page(pc, 'decrypt'); await paste(pc, ''.join(chars))
        await pc.wait_for_selector('#decryptResult :text("damaged")', timeout=15000)
        check('a changed packet fails cleanly', True)
        # whitespace and line breaks added by chat apps are tolerated
        await paste(pc, '\n'.join(packet[i:i + 40] for i in range(0, len(packet), 40)))
        await pc.wait_for_selector('#decryptResult :text("DECRYPTION SUCCESSFUL")', timeout=15000)
        check('line breaks added by a chat app are tolerated', True)

        # ── Recipient without keys ──
        await goto_page(pa, 'encrypt'); await pa.fill('#plaintext', 'x')
        await pa.fill('#recipientSearch', 'dave'); await pa.wait_for_selector('#recipientResults button:has-text("dave")')
        await pa.click('#recipientResults button:has-text("dave")')
        await pa.wait_for_selector('#recipientHint.bad', timeout=8000)
        check('a person without keys is flagged before sending', 'not set up' in (await pa.inner_text('#recipientHint')))
        await pa.click('#encryptBtn'); await pa.wait_for_selector('#encryptResult :text("not set up")', timeout=8000)
        check('and encryption is refused with advice', True)
        await goto_page(pa, 'encrypt'); await pa.fill('#plaintext', 'x'); await pa.click('#encryptBtn')
        await pa.wait_for_selector('#encryptResult :text("Search for the person")', timeout=5000)
        check('nothing is encrypted until a recipient is chosen', await pa.locator('#encPacketText').count() == 0)

        # ── Generated key mode ──
        await goto_page(pa, 'encrypt'); await pa.fill('#plaintext', MSG)
        await pa.click('#encModes [data-mode=key]')
        key1 = (await pa.inner_text('#genKeyValue')).strip()
        check('a strong key is generated (20 characters, 5 groups)', re.fullmatch(r'([2-9A-HJKMNP-Z]{4}-){4}[2-9A-HJKMNP-Z]{4}', key1) is not None, key1)
        await pa.click('#genKeyNew'); key2 = (await pa.inner_text('#genKeyValue')).strip()
        check('"New key" makes a different key', key1 != key2)
        await pa.click('#encryptBtn'); await pa.wait_for_selector('#encPacketText', timeout=20000)
        packet2 = (await pa.inner_text('#encPacketText')).strip()
        shown_key = (await pa.inner_text('.gc-keyresult code')).strip()
        check('the key shown with the result is the one used', shown_key == key2, shown_key)
        key3 = (await pa.inner_text('#genKeyValue')).strip()
        check('the next message gets a fresh key', key3 not in (key1, key2))
        await goto_page(pb, 'decrypt'); await paste(pb, packet2)
        await pb.wait_for_selector('#decryptPwRow:not([hidden])')
        check('key packets ask for the key', 'key' in (await pb.inner_text('#decryptDetect')).lower())
        await pb.fill('#decryptPassword', 'wrong-key-123'); await pb.press('#decryptPassword', 'Enter')
        await pb.wait_for_selector('#decryptResult :text("Wrong key")', timeout=20000)
        check('wrong key is refused', True)
        await pb.fill('#decryptPassword', shown_key.lower().replace('-', '')); await pb.press('#decryptPassword', 'Enter')
        await pb.wait_for_selector('#decryptResult :text("DECRYPTION SUCCESSFUL")', timeout=20000)
        got = await pb.evaluate("[...document.querySelectorAll('#decryptResult div')].map(d=>d.innerText).find(t=>t.includes('Ama'))||''")
        check('key typed in lower case without dashes still opens it, message intact', MSG in got, got[:100])

        # ── own key still works (old behaviour) ──
        await goto_page(pa, 'encrypt'); await pa.fill('#plaintext', 'plain old mode 🔐')
        await pa.click('#encModes [data-mode=key]'); await pa.click('input[name=keyChoice][value=own]')
        await pa.fill('#encryptPassword', 'short'); await pa.click('#encryptBtn')
        await pa.wait_for_selector('#encryptResult :text("at least 8")', timeout=5000)
        check('own key must be 8+ characters', True)
        await pa.fill('#encryptPassword', 'my-own-key-2026'); await pa.click('#encryptBtn'); await pa.wait_for_selector('#encPacketText', timeout=20000)
        packet3 = (await pa.inner_text('#encPacketText')).strip()
        await goto_page(pb, 'decrypt'); await paste(pb, packet3); await pb.fill('#decryptPassword', 'my-own-key-2026'); await pb.press('#decryptPassword', 'Enter')
        await pb.wait_for_selector('#decryptResult :text("DECRYPTION SUCCESSFUL")', timeout=20000)
        check('own-key mode still works as before', True)

        # ── emoji picker ──
        await goto_page(pa, 'encrypt'); await pa.fill('#plaintext', 'ab'); await pa.evaluate("document.getElementById('plaintext').setSelectionRange(1,1)")
        await pa.click('.gc-fieldwrap .gc-emo-btn'); await pa.wait_for_selector('.gc-emo', timeout=3000)
        await pa.fill('.gc-emo input', 'fire'); await pa.wait_for_selector('.gc-emo-grid button')
        first = await pa.inner_text('.gc-emo-grid button'); await pa.click('.gc-emo-grid button')
        val = await pa.input_value('#plaintext')
        check('picker search finds an emoji and inserts it at the cursor', val == 'a' + first + 'b' and first == '🔥', val)
        await pa.keyboard.press('Escape'); check('Escape closes the picker', await pa.locator('.gc-emo').count() == 0)
        await pa.click('.gc-fieldwrap .gc-emo-btn'); await pa.click('.gc-emo-tabs button[data-c=Animals]'); await pa.click('.gc-emo-grid button >> nth=0')
        check('categories work', (await pa.input_value('#plaintext')).count('🐶') == 1)
        await pa.screenshot(path='/tmp/claude-0/shots/send-picker.png')

        # ── emoji picker in chat ──
        await pa.goto(B + '/chat.html'); await pa.wait_for_selector('.contact-item', timeout=20000); await pa.click('.contact-item >> nth=0'); await pa.wait_for_selector('#chatInput', timeout=15000); await pa.wait_for_timeout(800)
        check('chat has an emoji button', await pa.locator('#emojiBtn').count() == 1)
        await pa.fill('#chatInput', 'hi '); await pa.click('#emojiBtn'); await pa.wait_for_selector('.gc-emo')
        await pa.fill('.gc-emo input', 'heart'); await pa.click('.gc-emo-grid button >> nth=0')
        check('chat input receives the emoji', (await pa.input_value('#chatInput')).startswith('hi ') and len(await pa.input_value('#chatInput')) > 3)
        await pa.screenshot(path='/tmp/claude-0/shots/send-chat-picker.png')

        # ── phone layout ──
        cm, pm, _, em = await login(br, 'alice', mobile=True)
        await goto_page(pm, 'encrypt'); await pm.fill('#plaintext', 'hi'); await pm.fill('#recipientSearch', 'bob'); await pm.wait_for_selector('#recipientResults button')
        await pm.screenshot(path='/tmp/claude-0/shots/send-phone-user.png', full_page=True)
        await pm.click('#encModes [data-mode=key]'); await pm.screenshot(path='/tmp/claude-0/shots/send-phone-key.png', full_page=True)
        ow = await pm.evaluate("document.documentElement.scrollWidth - innerWidth")
        check('phone layout has no sideways scroll', ow <= 1, ow)
        await goto_page(pm, 'decrypt'); await paste(pm, packet2); await pm.screenshot(path='/tmp/claude-0/shots/send-phone-decrypt.png', full_page=True)

        errs = ea + eb + ec + em
        check('no script errors on any page', not errs, errs[:3])
        await br.close()
    print(f'{sum(res)}/{len(res)} checks passed'); sys.exit(0 if all(res) else 1)
asyncio.run(main())
