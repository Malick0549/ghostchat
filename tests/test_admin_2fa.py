import os, sqlite3
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'test_security.py')).read().split("alice=user('alice')")[0])
def sql(q,*a):
    d=sqlite3.connect(os.environ['GC_TEST_DB']); r=d.execute(q,a).fetchall(); d.commit(); d.close(); return r
a=C(); r=a.login('alice')                                   # alice is the admin
check('admin password alone does NOT sign in',r.ok and r.json().get('requires_2fa') is True,r.text)
check('no access to the admin area before the code',a.get('/api/admin/users').status_code in (401,403))
check('wrong code refused',a.post('/api/auth/2fa/verify',{'code':'000000'}).status_code in (400,401))
code=sql("select two_factor_code from users where username='alice'")[0][0]
r=a.post('/api/auth/2fa/verify',{'code':code}); check('the emailed code signs the admin in',r.ok,r.text)
check('admin area works after the code',a.get('/api/admin/users').status_code==200)
a.csrf(); r=a.put('/api/profile',{'two_factor_enabled':False}); check('admin cannot turn 2FA off',r.status_code==400,r.text)
b=C(); r=b.login('bob'); check('normal users are not forced to use 2FA',r.ok and not r.json().get('requires_2fa'),r.text)
print(sum(1 for _,o in res if o),'/',len(res))
