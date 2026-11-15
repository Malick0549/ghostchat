import os
import sys; sys.argv=['x']
exec(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'test_security.py')).read().split("alice=user('alice')")[0])
import sqlite3
def sql(q,*a): 
    c=sqlite3.connect(os.environ['GC_TEST_DB']); r=c.execute(q,a).fetchall(); c.close(); return r
P='/api/admin/console'
adm=user('alice'); bob=user('bob'); mal=user('mallory'); carol=user('carol'); dave=user('dave')
# non-admin blocked
check('M0 non-admin cannot moderate', bob.post(f"{P}/users/{IDS['carol']}/suspend",{'days':1,'reason':'xx test'}).status_code==403)
# verify / unverify
r=adm.post(f"{P}/users/{IDS['mallory']}/verify",{'verified':False}); check('M1 unverify needs reason',r.status_code==400)
r=adm.post(f"{P}/users/{IDS['mallory']}/verify",{'verified':False,'reason':'suspicious signup'}); check('M1b unverify ok',r.ok and sql("select is_verified from users where username='mallory'")[0][0]==0,r.text)
check('M1c unverified user session is signed out', mal.get('/api/auth/me').status_code==401)
l=C().login('mallory'); check('M1d unverified user cannot sign in', l.status_code==403 and l.json().get('requires_verification'), l.text)
r=adm.post(f"{P}/users/{IDS['mallory']}/verify",{'verified':True}); check('M1e verify ok', r.ok and C().login('mallory').ok, r.text)
check('M1f cannot unverify admin/self', adm.post(f"{P}/users/{IDS['alice']}/verify",{'verified':False,'reason':'test x'}).status_code==400)
# suspend
bs=user('bob'); b_sio,b_got=sock(bs,uid=IDS['bob'])
r=adm.post(f"{P}/users/{IDS['bob']}/suspend",{'days':3,'reason':'spamming users','notify':True}); check('M2 suspend ok',r.ok,r.text)
check('M2b suspended session blocked', bs.get('/api/auth/me').status_code in (401,403))
l=C().login('bob'); check('M2c suspended login refused with reason', l.status_code==403 and 'suspended' in l.text.lower() and 'spamming' in l.text, (l.status_code,l.text))
l=C().login('bob','WrongPass1!'); check('M2d wrong password does not reveal suspension', l.status_code==401, l.text)
check('M2e suspend row has end date', sql("select until from suspensions")[0][0] is not None)
sql_c=sqlite3.connect(os.environ['GC_TEST_DB']); sql_c.execute("update suspensions set until=datetime('now','-1 minute')"); sql_c.commit(); sql_c.close()
l=C().login('bob'); check('M2f expired suspension lifts automatically', l.ok and sql("select count(*) from suspensions")[0][0]==0, l.text)
adm.post(f"{P}/users/{IDS['bob']}/suspend",{'days':0,'reason':'indefinite test'}); 
r=adm.post(f"{P}/users/{IDS['bob']}/unsuspend",{}); check('M2g unsuspend', r.ok and C().login('bob').ok, r.text)
check('M2h cannot suspend admin', adm.post(f"{P}/users/{IDS['alice']}/suspend",{'days':1,'reason':'self test'}).status_code==400)
# reports
bob=user('bob')
mal=user('mallory'); r=mal.post('/api/reports',{'reported_id':IDS['alice'],'reason':'spam'}); check('R1 cannot report non-contact', r.status_code==403, r.text)
r=bob.post('/api/reports',{'reported_id':IDS['alice'],'reason':'bogus'}); check('R2 bad reason rejected', r.status_code==400)
r=bob.post('/api/reports',{'reported_id':IDS['bob'],'reason':'spam'}); check('R3 cannot report self', r.status_code==400)
r=bob.post('/api/reports',{'reported_id':IDS['alice'],'reason':'harassment','details':'<script>x</script> keeps messaging','evidence':'you are dumb'}); check('R4 report created', r.status_code==201, r.text)
r=bob.post('/api/reports',{'reported_id':IDS['alice'],'reason':'harassment'}); check('R5 duplicate collapsed', r.ok and r.json().get('duplicate'), r.text)
check('R6 non-admin cannot read queue', bob.get(f'{P}/reports').status_code==403)
q=adm.get(f'{P}/reports?status=open').json(); check('R7 admin sees report', q['total']==1 and q['reports'][0]['reporter']['username']=='bob', q)
check('R7b summary badge', adm.get(f'{P}/reports/summary').json()['open']==1)
check('R8 my reports shows status', bob.get('/api/reports/mine').json()['reports'][0]['status']=='open')
# carol reports dave, with block
c=user('carol'); r=c.post('/api/reports',{'reported_id':IDS['dave'],'reason':'scam','block':True}); check('R9 report + block', r.status_code==201 and r.json()['blocked'], r.text)
rid=adm.get(f'{P}/reports?status=open').json()['reports']
dr=[x for x in rid if x['reported']['username']=='dave'][0]['id']; ar=[x for x in rid if x['reported']['username']=='alice'][0]['id']
check('R10 resolve needs note for action', adm.post(f'{P}/reports/{dr}/resolve',{'action':'warn'}).status_code==400)
r=adm.post(f'{P}/reports/{dr}/resolve',{'action':'warn','note':'Please stop this behaviour','notify_reporter':True}); check('R11 warn sends mail + closes', r.ok and r.json()['status']=='actioned', r.text)
r=adm.post(f'{P}/reports/{ar}/resolve',{'action':'dismiss','note':'','notify_reporter':False}); check('R12 admin accounts cannot be moderated but dismiss works', r.ok and r.json()['status']=='dismissed', r.text)
check('R13 queue now empty', adm.get(f'{P}/reports?status=open').json()['total']==0)
# delete
r=adm.post(f"{P}/users/{IDS['dave']}/delete",{}); check('D1 delete needs exact username', r.status_code==400)
adm.csrf()
r=adm.s.post(B+f"{P}/users/{IDS['dave']}/delete",json={'confirm':'dave','reason':'abuse','notify':True},headers=adm.h()); check('D2 delete ok',r.ok,r.text)
check('D3 user and their data gone', sql("select count(*) from users where username='dave'")[0][0]==0 and sql("select count(*) from contacts where user_id=? or contact_id=?",IDS['dave'],IDS['dave'])[0][0]==0)
check('D4 audit trail kept', sql("select count(*) from activity_logs where event_type='user_deleted'")[0][0]==1)
check('D5 report record survived deletion', sql("select count(*) from reports where reported_name='dave'")[0][0]==1)
check('D6 deleted user cannot sign in', C().login('dave').status_code==401)
check('D7 cannot delete self/admin', adm.s.post(B+f"{P}/users/{IDS['alice']}/delete",json={'confirm':'alice'},headers=adm.h()).status_code==400)
print('\nRESULT %d/%d passed'%(sum(1 for _,o in res if o),len(res)))
for n,o in res:
    if not o: print('  FAILED:',n)
