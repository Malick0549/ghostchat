import requests, socketio, json, time, io, struct, zlib, sys, os, itertools
B='http://127.0.0.1:5000'
IDS=json.load(open('/tmp/lv/ids.json'))
_n=itertools.count(1)
def xff(): return {'X-Forwarded-For': f'10.9.{next(_n)//250}.{next(_n)%250+1}'}
res=[]
def check(name, ok, info=''):
    res.append((name, bool(ok))); print(('PASS' if ok else 'FAIL'), '-', name, ('| '+str(info)) if info and not ok else '')

class C:
    def __init__(s):
        s.s=requests.Session(); s.tok=None
    def csrf(s):
        r=s.s.get(B+'/api/csrf-token', headers=xff()); s.tok=r.json()['csrf_token']
    def h(s,extra=None):
        h={'X-CSRF-Token': s.tok, **xff()}
        if extra: h.update(extra)
        return h
    def post(s,p,j=None,**k): return s.s.post(B+p,json=j,headers=s.h(),**k)
    def put(s,p,j=None): return s.s.put(B+p,json=j,headers=s.h())
    def get(s,p,**k): return s.s.get(B+p,headers=xff(),**k)
    def delete(s,p): return s.s.delete(B+p,headers=s.h())
    def login(s,u,p='Passw0rd!x'):
        s.csrf(); r=s.post('/api/auth/login',{'username':u,'password':p})
        if r.ok: s.csrf()
        return r
    def cookie(s): return '; '.join(f'{c.name}={c.value}' for c in s.s.cookies)

def user(n):
    c=C(); r=c.login(n); assert r.ok,(n,r.text); return c

def sock(c, rooms=None, uid=None):
    sio=socketio.Client(); got=[]
    sio.on('receive_message', lambda d: got.append(d))
    sio.on('typing', lambda d: got.append({'typing':d}))
    sio.on('message_failed', lambda d: got.append({'failed':d}))
    sio.connect(B, headers={'Cookie': c.cookie()}, transports=['polling'], wait_timeout=8)
    if uid: sio.emit('join_user_room', {'user_id': uid}); time.sleep(.4)
    return sio, got

alice=user('alice'); bob=user('bob'); mal=user('mallory'); carol=user('carol')
# need alice<->bob contact rows exist (seeded). 

# ── S1 eavesdrop via join_room(user_<victim>)
a_sio,a_got=sock(alice,uid=IDS['alice'])
m_sio,m_got=sock(mal,uid=IDS['mallory'])
m_sio.emit('join_room',{'room':'user_'+IDS['alice']}); time.sleep(.5)
r=bob.post(f"/api/chat/{IDS['alice']}/messages",{'content':'secret-from-bob'}); 
time.sleep(.8)
check('S1 attacker cannot eavesdrop by joining victim user room', not any(g.get('content')=='secret-from-bob' for g in m_got), 'mallory received victim message')
check('S1b legit recipient still receives', any(g.get('content')=='secret-from-bob' for g in a_got))
# unauthenticated socket
u_sio=socketio.Client(); ug=[]; u_sio.on('receive_message',lambda d:ug.append(d))
try:
    u_sio.connect(B,transports=['polling']); u_sio.emit('join_room',{'room':'user_'+IDS['alice']}); time.sleep(.4)
except Exception: pass
bob.post(f"/api/chat/{IDS['alice']}/messages",{'content':'secret2'}); time.sleep(.8)
check('S2 unauthenticated socket cannot join user room', not ug)
# S18 typing into arbitrary room
m_sio.emit('typing',{'room':'user_'+IDS['alice'],'user_id':IDS['mallory'],'username':'<b>x</b>'}); time.sleep(.5)
check('S18 cannot emit typing into a room you are not in', not any('typing' in g for g in a_got))
# ── S3 REST message to non-contact
r=mal.post(f"/api/chat/{IDS['alice']}/messages",{'content':'spam'})
check('S3 REST send to non-contact rejected', r.status_code==403, r.status_code)
# ── S12 spoofed identity fields over socket
b_sio,b_got=sock(bob,uid=IDS['bob'])
a_got.clear()
b_sio.emit('send_private_message',{'content':'hello','sender_id':IDS['bob'],'receiver_id':IDS['alice'],'sender':'ADMIN-Support','avatar':'https://evil.example/x.png','temp_id':'t1'})
time.sleep(.8)
rm=[g for g in a_got if g.get('content')=='hello']
check('S12 socket message ignores client-supplied name/avatar', rm and rm[0].get('sender')=='bob' and 'evil.example' not in str(rm[0].get('avatar')), rm[:1])
# ── S17 flood
b_got.clear()
t0=time.time()
for i in range(60):
    b_sio.emit('send_private_message',{'content':f'f{i}','sender_id':IDS['bob'],'receiver_id':IDS['alice'],'temp_id':f'x{i}'}); time.sleep(.05)
time.sleep(12)
fails=[g for g in b_got if 'failed' in g]
check('S17 socket message flood is throttled', len(fails)>0, (len(fails), round(time.time()-t0,1)))
# ── S6 username validation
c=C(); c.csrf()
r=c.post('/api/auth/register',{'username':'<img src=x onerror=alert(1)>','email':'xss1@x.com','password':'Str0ng!Pass99'})
check('S6 username with HTML rejected', r.status_code==400, (r.status_code,r.text[:100]))
# ── S7 password policy
for pw,why in (('password','common'),('12345678','digits only'),('abcdefgh','letters only'),('x'*200+'A1','too long'),('Sam3user!!','contains username')):
    c.csrf(); r=c.post('/api/auth/register',{'username':'samuser' if why=='contains username' else 'pwtest'+str(next(_n)),'email':f'pw{next(_n)}@x.com','password':pw if why!='contains username' else 'samuser1234'})
    check(f'S7 weak password rejected ({why})', r.status_code==400, (r.status_code,r.text[:80]))
# ── S8 per-account lockout, rotating IPs
c=C(); c.csrf(); codes=[]
for i in range(14): codes.append(c.post('/api/auth/login',{'username':'dave','password':f'wrong{i}'}).status_code)
c2=C(); c2.csrf(); ok=c2.post('/api/auth/login',{'username':'dave','password':'Passw0rd!x'})
check('S8 account locks after repeated failures across rotating IPs', 429 in codes and ok.status_code==429, (codes, ok.status_code))
# ── S9 verify-email brute force
c=C(); c.csrf()
reg=c.post('/api/auth/register',{'username':'victimv','email':'victimv@x.com','password':'Str0ng!Pass99'})
codes=[c.post('/api/auth/verify-email',{'email':'victimv@x.com','code':f'{i:06d}'}).status_code for i in range(30)]
check('S9 verification-code guessing capped per account', 429 in codes[:12], codes)
# ── S10 session revoked after password change
s1=user('carol'); s2=user('carol')
r=s2.put('/api/profile/password',{'old_password':'Passw0rd!x','new_password':'N3w!Passw0rd77'})
time.sleep(.2)
check('S10 other sessions die after password change', s1.get('/api/auth/me').status_code==401, s1.get('/api/auth/me').status_code)
# ── S11 uploads unauthenticated
r=requests.get(B+'/assets/uploads/anything.png',headers=xff())
check('S11 /assets/uploads requires auth or is gone', r.status_code in (401,403,404) and r.status_code!=200)
# ── S13 media content check
alice2=user('alice')
fake=io.BytesIO(b'<html><script>alert(1)</script></html>')
alice2.csrf()
r=alice2.s.post(B+f"/api/chat/{IDS['bob']}/media",data={'media_type':'audio'},files={'file':('a.webm',fake,'audio/webm')},headers=alice2.h())
check('S13 audio upload with HTML content rejected', r.status_code==400, (r.status_code,r.text[:100]))
png=io.BytesIO(); 
from PIL import Image
Image.new('RGB',(4,4)).save(png,'PNG'); png.seek(0)
r=alice2.s.post(B+f"/api/chat/{IDS['bob']}/media",data={'media_type':'image'},files={'file':('a"\r\nX-Injected: 1.png',png,'image/png')},headers=alice2.h())
mid=r.json().get('message',{}).get('id') if r.ok else None
if mid:
    g=alice2.get(f'/api/media/{mid}')
    check('S13b media served with nosniff and no header injection', g.status_code==200 and g.headers.get('X-Content-Type-Options')=='nosniff' and 'X-Injected' not in g.headers, dict(g.headers))
else: check('S13b media upload with odd filename handled', r.status_code in (200,201,400), (r.status_code, r.text[:100]))
# ── S14 save_message type
r=alice2.post('/api/messages',{'encrypted_content':'x','message_type':'chat'})
check('S14 history API cannot forge chat message types', r.status_code==400, r.status_code)
# ── S15 headers
h=requests.get(B+'/login.html',headers=xff()).headers
csp=h.get('Content-Security-Policy','')
check('S15a CSP has no unsafe-eval', 'unsafe-eval' not in csp)
check('S15b CSP has frame-ancestors/base-uri/form-action', all(k in csp for k in ('frame-ancestors','base-uri','form-action')))
check('S15c COOP/CORP present', 'Cross-Origin-Opener-Policy' in h and 'Cross-Origin-Resource-Policy' in h)
# ── S16 login timing
def t(u):
    c=C(); c.csrf(); s=time.time(); c.post('/api/auth/login',{'username':u,'password':'Wrong!pass1'}); return time.time()-s
a=sorted(t('nosuchuser%d'%i) for i in range(5))[2]; b=sorted(t('bob') for i in range(5))[2]
check('S16 login timing does not reveal valid usernames', a>0.5*b, (round(a,3),round(b,3)))
# ── S19 CSRF
c=C(); r=c.s.post(B+'/api/auth/logout',json={},headers=xff())
check('S19 CSRF enforced on logout', r.status_code==403)
# ── S20 XFF spoof vs login rate limit (leftmost rotates, real tail fixed)
c=C(); c.csrf(); codes=[]
for i in range(25):
    codes.append(c.s.post(B+'/api/auth/login',json={'username':'nobody','password':'x'},headers={'X-CSRF-Token':c.tok,'X-Forwarded-For':f'6.6.6.{i}, 203.0.113.9'}).status_code)
check('S20 rate limit cannot be dodged by forging X-Forwarded-For', 429 in codes, codes)
# ── S5 blocked
cl=alice.get('/api/contacts').json()
rows=cl.get('contacts') or cl
bid=None
for c_ in rows:
    if c_.get('contact_id')==IDS['bob'] or c_.get('id')==IDS['bob'] or c_.get('user_id')==IDS['bob']: bid=c_.get('contact_row_id') or c_.get('connection_id') or c_.get('id')
rb=alice.post(f"/api/contacts/{IDS['bob']}/block")
r=bob.post(f"/api/chat/{IDS['alice']}/messages",{'content':'hi blocked'})
check('S5 blocked user cannot message', r.status_code in (403,), (r.status_code, rb.status_code if rb is not None else 'noblock', str(rows)[:200]))
print('\nRESULT %d/%d passed'%(sum(1 for _,o in res if o),len(res)))
for n,o in res:
    if not o: print('  FAILED:',n)
