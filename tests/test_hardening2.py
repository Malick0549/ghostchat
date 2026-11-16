"""Regression checks for the November security pass: CORS, cookies, uploads, malformed JSON."""
import os, sys, tempfile
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); _tmp=tempfile.mkdtemp(); os.chdir(root); sys.path.insert(0,root)
os.environ['DATABASE_URL']='sqlite:///'+_tmp+'/h2.db'; os.environ['FLASK_SECRET']='x'*40
import flask_app
app=flask_app.app; c=app.test_client(); res=[]
def check(n,ok,info=''): res.append(ok); print(('PASS' if ok else 'FAIL'),'-',n,info if not ok else '')
for o in ('null','https://evil.example','https://ghostchat-5slo.onrender.com','http://localhost:5000.evil.com'):
    r=c.get('/api/csrf-token',headers={'Origin':o}); check(f'CORS refuses origin {o}', r.headers.get('Access-Control-Allow-Origin') is None, r.headers.get('Access-Control-Allow-Origin'))
r=c.get('/api/csrf-token',headers={'Origin':'http://localhost:5000'}); check('CORS still allows the app itself', r.headers.get('Access-Control-Allow-Origin')=='http://localhost:5000')
tok=c.get('/api/csrf-token').get_json()['csrf_token']
r=c.post('/api/auth/login',data='{bad json',headers={'Content-Type':'application/json','X-CSRF-Token':tok}); check('malformed JSON answers 400, not 500', r.status_code==400, r.status_code)
cookies=[h for h in c.get('/api/csrf-token').headers.getlist('Set-Cookie')]
check('csrf cookie is SameSite=Lax', all('SameSite=Lax' in h for h in cookies) or not cookies, cookies)
check('session cookie default is Lax', app.config['SESSION_COOKIE_SAMESITE']=='Lax')
r=c.get('/assets/uploads/anything.png'); check('uploads need sign-in', r.status_code==401, r.status_code)
for p in ('/flask_app.py','/.env','/backend/models.py','/.git/config','/requirements.txt'):
    check(f'{p} not served', c.get(p).status_code==404)
print(f'{sum(res)}/{len(res)} checks passed'); sys.exit(0 if all(res) else 1)
