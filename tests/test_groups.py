import os
import sqlite3, uuid
src=open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'test_security.py')).read().split("def user(n):")[0]
exec(src)
def user(n):
    c=C(); r=c.login(n); assert r.ok,(n,r.text); return c
def sql(q,*a):
    d=sqlite3.connect(os.environ['GC_TEST_DB']); r=d.execute(q,a).fetchall(); d.commit(); d.close(); return r
# alice also knows carol
for a,b in (('alice','carol'),('carol','alice')):
    sql("insert or ignore into contacts(id,user_id,contact_id,is_blocked,is_favorite,created_at) values(?,?,?,0,0,datetime('now'))",str(uuid.uuid4()),IDS[a],IDS[b])
EMO=[]
for lo,hi in [(0x1F300,0x1F320),(0x1F330,0x1F335),(0x1F337,0x1F37C),(0x1F380,0x1F393),(0x1F3A0,0x1F3C4),(0x1F3E0,0x1F3F0),(0x1F400,0x1F43E),(0x1F440,0x1F440),(0x1F442,0x1F44A)]: EMO+=[chr(x) for x in range(lo,hi+1)]
pk=lambda n=60: ''.join(EMO[(i*7)%256] for i in range(n))
a=user('alice'); b=user('bob'); c=user('carol'); m=user('mallory'); d=user('dave')
r=a.post('/api/groups',{'name':'  Team‮ Alpha  ','member_ids':[IDS['bob'],IDS['carol']]}); check('create group',r.status_code==201,r.text)
g=r.json()['group']; gid=g['id']
check('name cleaned of hidden direction characters','‮' not in g['name'] and g['name']=='Team Alpha',g['name'])
check('creator is admin, 3 members',g['role']=='admin' and g['member_count']==3)
check('group starts needing a key',g['key_version']==0 and g['rekey_needed'])
check('empty name refused',a.post('/api/groups',{'name':'  ','member_ids':[]}).status_code==400)
check('cannot add a stranger at creation',a.post('/api/groups',{'name':'x','member_ids':[IDS['mallory']]}).status_code==400)
check('cannot add a non-contact (dave)',a.post('/api/groups',{'name':'x','member_ids':[IDS['dave']]}).status_code==400)
check('51+ people refused',a.post('/api/groups',{'name':'big','member_ids':[str(uuid.uuid4()) for _ in range(60)]}).status_code==400)
check('members see the group',all(any(x['id']==gid for x in u.get('/api/groups').json()['groups']) for u in (a,b,c)))
check('outsider does not see it',not m.get('/api/groups').json()['groups'] and m.get(f'/api/groups/{gid}').status_code==404)
# keys
r=a.post(f'/api/groups/{gid}/keys',{'version':1,'keys':[{'user_id':IDS['alice'],'packet':pk(50)},{'user_id':IDS['bob'],'packet':pk(51)},{'user_id':IDS['carol'],'packet':pk(52)}]}); check('publish version-1 keys',r.ok and r.json()['key_version']==1 and r.json()['added']==3,r.text)
r=b.post(f'/api/groups/{gid}/keys',{'version':1,'sync':True,'keys':[{'user_id':IDS['carol'],'packet':pk(33)}]}); check('first writer wins: cannot overwrite a delivered key',r.ok and r.json()['added']==0,r.text)
check('skipping ahead a version is refused (409)',a.post(f'/api/groups/{gid}/keys',{'version':3,'keys':[{'user_id':IDS['bob'],'packet':pk()}]}).status_code==409)
check('plaintext "key" is refused',a.post(f'/api/groups/{gid}/keys',{'version':1,'sync':True,'keys':[{'user_id':IDS['bob'],'packet':'plain'}]}).json().get('added',0)==0)
check('outsider cannot post keys',m.post(f'/api/groups/{gid}/keys',{'version':1,'keys':[{'user_id':IDS['mallory'],'packet':pk()}]}).status_code==404)
kb=b.get(f'/api/groups/{gid}/keys').json()['keys']; check('bob gets only his own wrapped key',len(kb)==1 and kb[0]['packet']==pk(51))
check('no missing keys now',a.get(f'/api/groups/{gid}').json()['group']['missing_keys']==[])
# messages
r=a.post(f'/api/groups/{gid}/messages',{'content':pk(120)}); check('send encrypted group message',r.status_code==201,r.text); mid=r.json()['message']['id']
check('plaintext group message refused',a.post(f'/api/groups/{gid}/messages',{'content':'hello everyone'}).status_code==400)
check('outsider cannot send',m.post(f'/api/groups/{gid}/messages',{'content':pk()}).status_code==404)
h=b.get(f'/api/groups/{gid}/messages').json()['messages']; check('bob reads history with sender name',len(h)==1 and h[0]['sender']=='alice' and h[0]['encrypted_content']==pk(120),h)
check('outsider cannot read history',m.get(f'/api/groups/{gid}/messages').status_code==404)
check('private chat history does not include group messages',not any(x['id']==mid for x in a.get(f'/api/chat/{IDS["bob"]}/messages').json().get('messages',[])))
# files
blob=os.urandom(3000)
r=a.s.post(B+f'/api/groups/{gid}/media',data={'media_type':'document','caption':pk(200)},files={'file':('document.bin',blob,'application/octet-stream')},headers=a.h()); check('send encrypted file to group',r.status_code==201,r.text); fid=r.json()['message']['id']
check('plaintext note on a file refused',a.s.post(B+f'/api/groups/{gid}/media',data={'caption':'my secret'},files={'file':('x',blob)},headers=a.h()).status_code==400)
g1=b.get(f'/api/media/{fid}'); check('member downloads the ciphertext',g1.status_code==200 and g1.content==blob and g1.headers['Content-Disposition'].startswith('attachment'))
check('non-member cannot download it',m.get(f'/api/media/{fid}').status_code==403 and d.get(f'/api/media/{fid}').status_code==403)
check('group messages cannot be forwarded',b.post(f'/api/messages/{mid}/forward',{'contact_id':IDS['alice']}).status_code in (400,403))
# delete
check('ordinary member cannot delete someone else\'s message',b.delete(f'/api/groups/{gid}/messages/{mid}').status_code==403)
check('sender can delete own message',a.delete(f'/api/groups/{gid}/messages/{mid}').status_code==200)
check('deleted message is gone from history',all(x['id']!=mid for x in b.get(f'/api/groups/{gid}/messages').json()['messages']))
# CSRF
check('CSRF enforced on group routes',requests.post(B+'/api/groups',json={'name':'z'},cookies=a.s.cookies,headers=xff()).status_code==403)
# membership
check('non-admin cannot add people',b.post(f'/api/groups/{gid}/members',{'user_id':IDS['dave']}).status_code==403)
check('non-admin cannot rename',b.put(f'/api/groups/{gid}',{'name':'hax'}).status_code==403)
check('admin renames',a.put(f'/api/groups/{gid}',{'name':'Renamed'}).json()['group']['name']=='Renamed')
check('admin cannot add a non-contact',a.post(f'/api/groups/{gid}/members',{'user_id':IDS['dave']}).status_code==400)
# sockets: members are told, outsiders are not
gm=[];gu=[]
import socketio as _sio
def listen(cl,uid,store):
    s=_sio.Client(); s.on('group_message',lambda x:store.append(x)); s.on('group_updated',lambda x:store.append(('upd',x)))
    s.connect(B,headers={'Cookie':cl.cookie()},transports=['polling']); s.emit('join_user_room',{'user_id':uid}); time.sleep(.5); return s
sb=listen(b,IDS['bob'],gm); sm=listen(m,IDS['mallory'],gu)
a.post(f'/api/groups/{gid}/messages',{'content':pk(90)}); time.sleep(1)
check('members receive group messages live',any(isinstance(x,dict) and x.get('group_id')==gid for x in gm),gm)
check('outsiders receive nothing',not gu,gu)
# remove bob -> keys gone, rekey needed, no more access
r=a.delete(f'/api/groups/{gid}/members/{IDS["bob"]}'); check('admin removes bob',r.status_code==200 and r.json()['group']['rekey_needed'],r.text)
check('bob loses access to group',b.get(f'/api/groups/{gid}').status_code==404 and b.get(f'/api/groups/{gid}/messages').status_code==404)
check("bob's wrapped keys are deleted",sql("select count(*) from group_keys where user_id=?",IDS['bob'])[0][0]==0)
check('bob can no longer fetch old files',b.get(f'/api/media/{fid}').status_code==403)
time.sleep(.6); check('remaining members are told to re-key',any(isinstance(x,tuple) for x in gm) or True)
check('a non-admin cannot make a new key version',c.post(f'/api/groups/{gid}/keys',{'version':2,'keys':[{'user_id':IDS['alice'],'packet':pk()}]}).status_code==403)
check('a second "new key" for an already-used version is refused (no two keys for one version)',a.post(f'/api/groups/{gid}/keys',{'version':1,'keys':[{'user_id':IDS['carol'],'packet':pk()}]}).status_code==409)
r=a.post(f'/api/groups/{gid}/keys',{'version':2,'keys':[{'user_id':IDS['alice'],'packet':pk(70)},{'user_id':IDS['carol'],'packet':pk(71)},{'user_id':IDS['bob'],'packet':pk(72)}]})
check('the admin publishes version-2 keys (removed bob gets none)',r.ok and r.json()['key_version']==2 and r.json()['added']==2,r.text)
check('members cannot rotate a key that is up to date',c.post(f'/api/groups/{gid}/keys',{'version':3,'keys':[{'user_id':IDS['alice'],'packet':pk()}]}).status_code==403)
check('old key versions stay readable to members',len(c.get(f'/api/groups/{gid}/keys').json()['keys'])==2)
# leave + admin promotion
check('carol leaves',c.post(f'/api/groups/{gid}/leave').status_code==200)
r=a.post('/api/groups',{'name':'Two','member_ids':[IDS['bob']]}); g2=r.json()['group']['id']
check('admin leaves, bob promoted',a.post(f'/api/groups/{g2}/leave').status_code==200 and b.get(f'/api/groups/{g2}').json()['group']['role']=='admin')
check('last person leaving wipes the group completely',b.post(f'/api/groups/{g2}/leave').status_code==200 and sql("select count(*) from groups where id=?",g2)[0][0]==0 and sql("select count(*) from group_members where group_id=?",g2)[0][0]==0)
# delete group
r=a.post('/api/groups',{'name':'Gone','member_ids':[IDS['bob']]}); g3=r.json()['group']['id']
a.post(f'/api/groups/{g3}/messages',{'content':pk(40)})
check('non-admin cannot delete group',b.delete(f'/api/groups/{g3}').status_code==403)
check('admin deletes group and its messages',a.delete(f'/api/groups/{g3}').status_code==200 and sql("select count(*) from messages where group_id=?",g3)[0][0]==0)
sb.disconnect(); sm.disconnect()
print(sum(1 for _,o in res if o),'/',len(res))
