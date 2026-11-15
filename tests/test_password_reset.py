import os
import sqlite3, time
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'test_security.py')).read().split("alice=user('alice')")[0])
def sql(q,*a):
    d=sqlite3.connect(os.environ['GC_TEST_DB']); r=d.execute(q,a).fetchall(); d.commit(); d.close(); return r
em=sql("select email from users where username='mallory'")[0][0]
OLD='Passw0rd!x'; NEW='Brand-New-Pass9'
c=C(); c.csrf()
r=c.post('/api/auth/forgot-password',{'email':em}); check('forgot-password accepts a registered email',r.status_code==200,r.text)
r2=c.post('/api/auth/forgot-password',{'email':'nobody-here@example.com'}); check('unknown email gets the same reply (no account guessing)',r2.status_code==200 and r2.json()['message']==r.json()['message'],r2.text)
check('empty email rejected',c.post('/api/auth/forgot-password',{'email':''}).status_code==400)
import hashlib
stored=sql("select reset_token from users where username='mallory'")[0][0]
check('a reset token was created and only its SHA-256 hash is stored',bool(stored) and len(stored)==64 and all(ch in '0123456789abcdef' for ch in stored))
def plant():                                    # stands in for the emailed link: raw token -> its hash in the DB
    raw='T'+hashlib.sha256(str(time.time()).encode()).hexdigest()[:42]
    sql("update users set reset_token=?, reset_token_expires=datetime('now','+10 minutes') where username='mallory'",hashlib.sha256(raw.encode()).hexdigest()); return raw
tok=plant()
check('the hash itself cannot be used as a reset link',c.post('/api/auth/reset-password',{'token':stored,'new_password':NEW}).status_code==400)
check('reset page is served',c.get('/forgot-password.html?token='+tok).status_code==200)
check('bad token refused',c.post('/api/auth/reset-password',{'token':'x'*43,'new_password':NEW}).status_code==400)
check('weak password refused',c.post('/api/auth/reset-password',{'token':tok,'new_password':'short'}).status_code==400)
# an already-signed-in session of mallory, to see whether a reset signs it out
old=C(); assert old.login('mallory').ok
check('old session works before reset',old.get('/api/profile').status_code==200)
r=c.post('/api/auth/reset-password',{'token':tok,'new_password':NEW}); check('reset with the real token works',r.status_code==200,r.text)
check('old password no longer works',C().login('mallory',OLD).status_code in (400,401))
n=C(); check('new password works',n.login('mallory',NEW).ok)
check('token cannot be used twice',c.post('/api/auth/reset-password',{'token':tok,'new_password':'Another-Pass77'}).status_code==400)
check('existing session was signed out by the reset',old.get('/api/profile').status_code in (401,403),old.get('/api/profile').status_code)
ev=[e[0] for e in sql("select event_type from activity_logs where user_id=(select id from users where username='mallory')")]
check('admin log has reset requested + completed','password_reset_requested' in ev and 'password_reset_completed' in ev,ev)
# expiry
c.csrf(); c.post('/api/auth/forgot-password',{'email':em}); t2=plant()
sql("update users set reset_token_expires=datetime('now','-1 minute') where username='mallory'")
check('expired token refused',c.post('/api/auth/reset-password',{'token':t2,'new_password':'Another-Pass77'}).status_code==400)
# newer request replaces older token
c.csrf(); a=plant()
c.post('/api/auth/forgot-password',{'email':em})
check('a newer request invalidates the older link', c.post('/api/auth/reset-password',{'token':a,'new_password':'Another-Pass77'}).status_code==400)
sql("update users set reset_token=null where username='mallory'")
# restore password for other suites
print(sum(1 for _,o in res if o),'/',len(res))
