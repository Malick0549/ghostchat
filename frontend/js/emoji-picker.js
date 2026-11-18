/**
 * GHOSTCHAT EMOJI PICKER
 * A small, self-contained picker for people whose keyboard has no emoji key (most desktops).
 * No outside library, no network. Add a button with data-emoji-for="#someTextareaId" and it just works:
 *     <button type="button" data-emoji-for="#plaintext">😀</button>
 * The emoji is inserted where the cursor is and an `input` event is fired so the page reacts as if it was typed.
 */
(function () {
  'use strict';
  const DATA = {
    'Smileys': '😀 grin happy|😃 smile|😄 laugh|😁 beam|😆 haha|😅 sweat relief|😂 joy tears lol|🤣 rofl|🙂 slight smile|😉 wink|😊 blush|😇 angel|🥰 love hearts|😍 heart eyes|🤩 star struck wow|😘 kiss|😋 yum tasty|😛 tongue|😜 crazy wink|🤪 zany|🤗 hug|🤔 think|🤭 oops giggle|🤫 shh secret|😐 neutral|😶 silent|🙄 eye roll|😏 smirk|😴 sleep|😌 relieved|😎 cool sunglasses|🤓 nerd|🥳 party|😕 confused|😟 worried|🙁 sad|😢 cry|😭 sob|😤 huff|😡 angry|🤬 swear|😱 scream shock|😨 fear|😰 anxious|🥺 pleading|😳 flushed|🥵 hot|🥶 cold|🤒 sick|🤕 hurt|🤢 nausea|🥴 woozy|😈 devil|👻 ghost|💀 skull|🤖 robot|🎃 pumpkin',
    'Hands': '👍 thumbs up yes ok|👎 thumbs down no|👌 ok perfect|✌️ peace victory|🤞 fingers crossed luck|🤟 love you|🤘 rock|🤙 call me|👈 left|👉 right|👆 up|👇 down|☝️ one|✋ stop hand|🖐️ high five|👋 wave hello bye|🤝 handshake deal|👏 clap|🙌 raise hands praise|🙏 pray thanks please|💪 strong muscle|🫶 heart hands|✍️ write|🤳 selfie|👀 eyes look|🧠 brain|🫡 salute|🤲 palms|👊 fist bump|✊ fist',
    'Hearts': '❤️ red heart love|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|🤎 brown heart|💔 broken heart|❣️ heart exclamation|💕 two hearts|💞 revolving hearts|💓 beating heart|💗 growing heart|💖 sparkling heart|💘 cupid arrow|💝 gift heart|💯 hundred perfect|✨ sparkles|⭐ star|🌟 glowing star|💫 dizzy|🔥 fire hot|💥 boom|💢 anger|💦 water drops|🎉 party popper celebrate|🎊 confetti|🎁 gift present',
    'People': '👶 baby|🧒 child|👦 boy|👧 girl|🧑 person|👨 man|👩 woman|🧓 older person|👴 old man|👵 old woman|👨‍👩‍👧 family|👨‍👩‍👧‍👦 family|👩‍❤️‍👨 couple|💑 couple love|👮 police|🧑‍⚕️ doctor|🧑‍🏫 teacher|🧑‍💻 developer|🧑‍🍳 cook|🧑‍🌾 farmer|🦸 hero|🧙 wizard|🧛 vampire|🧟 zombie|🏃 run|🚶 walk|💃 dance woman|🕺 dance man|🤷 shrug|🤦 facepalm|🙋 raise hand|🙇 bow|🤰 pregnant',
    'Animals': '🐶 dog|🐱 cat|🐭 mouse|🐹 hamster|🐰 rabbit|🦊 fox|🐻 bear|🐼 panda|🐨 koala|🐯 tiger|🦁 lion|🐮 cow|🐷 pig|🐸 frog|🐵 monkey|🙈 see no evil|🙉 hear no evil|🙊 speak no evil|🐔 chicken|🐧 penguin|🐦 bird|🦅 eagle|🦉 owl|🦇 bat|🐺 wolf|🐴 horse|🦄 unicorn|🐝 bee|🦋 butterfly|🐛 bug|🐌 snail|🐢 turtle|🐍 snake|🐙 octopus|🐠 fish|🐬 dolphin|🐳 whale|🦈 shark|🐘 elephant|🦒 giraffe|🦓 zebra|🐪 camel|🌳 tree|🌴 palm|🌵 cactus|🌸 blossom|🌹 rose|🌻 sunflower|🍀 clover luck|🍁 leaf',
    'Food': '🍎 apple|🍌 banana|🍉 watermelon|🍇 grapes|🍓 strawberry|🍍 pineapple|🥭 mango|🍑 peach|🍒 cherries|🍋 lemon|🥑 avocado|🍅 tomato|🥕 carrot|🌽 corn|🌶️ pepper chili|🥔 potato|🍞 bread|🧀 cheese|🥚 egg|🍳 cooking|🥞 pancakes|🍗 chicken leg|🍖 meat|🍔 burger|🍟 fries|🍕 pizza|🌭 hot dog|🌮 taco|🍝 spaghetti|🍜 noodles|🍲 stew|🍛 curry rice|🍚 rice|🍣 sushi|🍦 ice cream|🍩 donut|🍪 cookie|🎂 birthday cake|🍫 chocolate|🍬 candy|☕ coffee|🍵 tea|🥤 drink|🍺 beer|🍷 wine|🥂 cheers|🍾 champagne|🥥 coconut',
    'Travel': '🚗 car|🚕 taxi|🚌 bus|🚑 ambulance|🚒 fire truck|🚓 police car|🏍️ motorbike|🚲 bicycle|🚂 train|✈️ plane|🚀 rocket|🚁 helicopter|⛵ sailboat|🚢 ship|⚓ anchor|🏠 house home|🏢 office|🏥 hospital|🏫 school|⛪ church|🕌 mosque|🏖️ beach|🏝️ island|🏔️ mountain|🌋 volcano|🌍 earth africa|🌎 earth americas|🌏 earth asia|🗺️ map|🧭 compass|⛺ camping|🌅 sunrise|🌄 sunrise mountain|🌇 sunset|🌃 night|🌉 bridge|🎡 ferris wheel',
    'Objects': '⌚ watch|📱 phone mobile|💻 laptop|⌨️ keyboard|🖥️ desktop|🖨️ printer|📷 camera|📹 video camera|🎥 movie|📺 tv|📻 radio|🎙️ microphone|🎧 headphones|🎵 music note|🎶 music|🎤 sing|🎸 guitar|🥁 drum|🔋 battery|🔌 plug|💡 idea bulb|🔦 flashlight|📚 books|📖 book open|📝 memo note|✏️ pencil|📌 pin|📎 paperclip|✂️ scissors|🔒 lock|🔓 unlock|🔑 key|🔨 hammer|🔧 wrench|⚙️ gear settings|🧲 magnet|💰 money bag|💵 dollar|💳 card|📦 package|📬 mailbox|✉️ envelope mail|📅 calendar|⏰ alarm|⏳ hourglass|🔔 bell|🔕 mute bell|🛒 cart|🕶️ sunglasses|👑 crown|💎 gem diamond|⚽ football soccer|🏀 basketball|🏆 trophy|🥇 gold medal|🎮 game|🎯 target',
    'Symbols': '✅ check done|☑️ checkbox|✔️ tick|❌ cross no|❎ cross mark|❓ question|❗ exclamation|‼️ double exclamation|⚠️ warning|🚫 prohibited|⛔ no entry|🔞 adults only|♻️ recycle|➕ plus|➖ minus|➗ divide|✖️ multiply|➡️ right arrow|⬅️ left arrow|⬆️ up arrow|⬇️ down arrow|🔄 refresh|🔁 repeat|🔙 back|🔝 top|🆗 ok button|🆕 new|🆓 free|🆘 sos|💤 sleep zzz|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🔶 orange diamond|🔷 blue diamond|♾️ infinity|©️ copyright|®️ registered|™️ trademark|🇬🇭 ghana flag|🇳🇬 nigeria flag|🇺🇸 usa flag|🇬🇧 uk flag|🏳️ white flag|🏴 black flag|🚩 red flag',
  };
  const ICONS = { 'Smileys': '😀', 'Hands': '👍', 'Hearts': '❤️', 'People': '🧑', 'Animals': '🐶', 'Food': '🍕', 'Travel': '🚗', 'Objects': '💡', 'Symbols': '✅' };
  const ALL = []; for (const [cat, str] of Object.entries(DATA)) for (const it of str.split('|')) { const i = it.indexOf(' '); ALL.push({ e: it.slice(0, i), k: (cat + ' ' + it.slice(i + 1)).toLowerCase() }); }
  const RECENT_KEY = 'gc_emoji_recent';
  const recent = { get() { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').slice(0, 16); } catch (_) { return []; } },
                   add(e) { try { const r = [e].concat(recent.get().filter(x => x !== e)).slice(0, 16); localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch (_) {} } };

  let pop = null, target = null, anchor = null, cat = 'Smileys', query = '';

  function css() {
    if (document.getElementById('gcEmojiCss')) return;
    const s = document.createElement('style'); s.id = 'gcEmojiCss';
    s.textContent = '.gc-emo{position:fixed;z-index:9500;width:min(340px,calc(100vw - 16px));background:var(--bg2,#151823);color:var(--t1,#fff);border:1px solid var(--border2,#333);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.55);display:flex;flex-direction:column;overflow:hidden}' +
      '.gc-emo input{margin:10px 10px 6px;padding:9px 12px;border-radius:10px;border:1px solid var(--border2,#333);background:var(--bg,#0b0d14);color:inherit;font-size:16px;width:auto}' +
      '.gc-emo-tabs{display:flex;gap:2px;padding:0 6px 6px;border-bottom:1px solid var(--border,#222);overflow-x:auto}' +
      '.gc-emo-tabs button{flex:0 0 auto;min-width:36px;height:34px;border:0;background:none;border-radius:8px;font-size:1.1rem;cursor:pointer;opacity:.6}' +
      '.gc-emo-tabs button.on{background:rgba(255,255,255,.1);opacity:1}' +
      '.gc-emo-grid{display:grid;grid-template-columns:repeat(8,1fr);gap:2px;padding:8px;height:220px;overflow-y:auto;align-content:start}' +
      '.gc-emo-grid button{border:0;background:none;border-radius:8px;font-size:1.4rem;height:38px;cursor:pointer;line-height:1}' +
      '.gc-emo-grid button:hover,.gc-emo-grid button:focus-visible{background:rgba(255,255,255,.12);outline:none}' +
      '.gc-emo-h{grid-column:1/-1;font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--t3,#889);padding:4px 4px 0}' +
      '.gc-emo-btn{background:none;border:1px solid var(--border2,#333);color:var(--t2,#aaa);border-radius:10px;min-width:38px;height:36px;cursor:pointer;font-size:1.05rem}' +
      '.gc-emo-btn:hover{color:var(--t1,#fff);border-color:var(--primary,#b9a7ff)}' +
      '@media (max-width:520px){.gc-emo{left:8px!important;right:8px;width:auto;bottom:8px!important;top:auto!important}}';
    document.head.appendChild(s);
  }
  function grid() {
    const g = pop.querySelector('.gc-emo-grid'); g.innerHTML = '';
    let list, head = '';
    if (query) { list = ALL.filter(x => x.k.includes(query)).map(x => x.e); head = list.length ? '' : 'No match'; }
    else if (cat === 'Recent') { list = recent.get(); head = list.length ? 'Recently used' : 'Nothing used yet'; }
    else { list = (DATA[cat] || '').split('|').map(t => t.slice(0, t.indexOf(' '))); }
    if (head) { const h = document.createElement('div'); h.className = 'gc-emo-h'; h.textContent = head; g.appendChild(h); }
    for (const e of list) { const b = document.createElement('button'); b.type = 'button'; b.textContent = e; b.setAttribute('aria-label', 'Insert ' + e); b.onclick = () => pick(e); g.appendChild(b); }
    pop.querySelectorAll('.gc-emo-tabs button').forEach(t => t.classList.toggle('on', !query && t.dataset.c === cat));
  }
  function pick(e) {
    if (!target) return;
    const t = target; t.focus();
    const a = t.selectionStart == null ? t.value.length : t.selectionStart, b = t.selectionEnd == null ? a : t.selectionEnd;
    t.value = t.value.slice(0, a) + e + t.value.slice(b);
    const pos = a + e.length; try { t.setSelectionRange(pos, pos); } catch (_) {}
    t.dispatchEvent(new Event('input', { bubbles: true }));
    recent.add(e);
  }
  function close() { if (pop) { pop.remove(); pop = null; } document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', esc, true); }
  const outside = ev => { if (pop && !pop.contains(ev.target) && !(anchor && anchor.contains(ev.target))) close(); };
  const esc = ev => { if (ev.key === 'Escape') { close(); if (target) target.focus(); } };
  function open(btn, ta) {
    close(); css(); target = ta; anchor = btn; query = ''; cat = recent.get().length ? 'Recent' : 'Smileys';
    pop = document.createElement('div'); pop.className = 'gc-emo'; pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', 'Emoji picker');
    pop.innerHTML = '<input type="search" placeholder="Search emoji (heart, fire, thanks…)" aria-label="Search emoji" autocomplete="off" /><div class="gc-emo-tabs"></div><div class="gc-emo-grid"></div>';
    const tabs = pop.querySelector('.gc-emo-tabs');
    for (const c of ['Recent'].concat(Object.keys(DATA))) { const t = document.createElement('button'); t.type = 'button'; t.dataset.c = c; t.title = c; t.textContent = c === 'Recent' ? '🕘' : ICONS[c]; t.onclick = () => { query = ''; pop.querySelector('input').value = ''; cat = c; grid(); }; tabs.appendChild(t); }
    pop.querySelector('input').addEventListener('input', e => { query = e.target.value.trim().toLowerCase(); grid(); });
    document.body.appendChild(pop);
    const r = btn.getBoundingClientRect(), h = pop.offsetHeight, w = pop.offsetWidth;
    let top = r.top - h - 8; if (top < 8) top = Math.min(r.bottom + 8, innerHeight - h - 8);
    pop.style.top = Math.max(8, top) + 'px'; pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    grid();
    document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', esc, true);
    if (!matchMedia('(pointer:coarse)').matches) pop.querySelector('input').focus();
  }
  document.addEventListener('click', ev => {
    const b = ev.target.closest && ev.target.closest('[data-emoji-for]');
    if (!b) return;
    ev.preventDefault();
    const ta = document.querySelector(b.getAttribute('data-emoji-for'));
    if (!ta) return;
    if (pop && anchor === b) return close();
    open(b, ta);
  });
  window.GhostEmoji = { open, close, count: ALL.length };
})();
