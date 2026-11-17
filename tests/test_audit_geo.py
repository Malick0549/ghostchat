"""Locations in the admin console: provider fallback, reuse of known places, and repair of old 'Unknown' rows."""
import os, sys, tempfile, json, io
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); _tmp=tempfile.mkdtemp(); os.chdir(root); sys.path.insert(0,root)
os.environ['DATABASE_URL']='sqlite:///'+_tmp+'/g.db'; os.environ['FLASK_SECRET']='x'*40; os.environ['ADMIN_2FA_REQUIRED']='0'
import urllib.request
from datetime import datetime, timedelta
os.environ['LOCATION_REQUIRED']='0'
import flask_app
from backend.models import db, User, ActivityLog
app=flask_app.app; res=[]
def check(n,ok,info=''): res.append(ok); print(('PASS' if ok else 'FAIL'),'-',n,info if not ok else '')
calls=[]
class R:
    def __init__(s,d): s.d=json.dumps(d).encode()
    def read(s): return s.d
    def __enter__(s): return s
    def __exit__(s,*a): return False
def fake(req,timeout=0):
    url=req.full_url if hasattr(req,'full_url') else req; calls.append(url)
    if 'ipwho.is' in url: raise OSError('blocked')                        # first service is down
    if 'geojs' in url: return R({'city':'Accra','country':'Ghana'})      # second one answers
    raise OSError('unexpected')
urllib.request.urlopen=fake
with app.app_context():
    a=User(username='boss',email='boss@x.com',is_verified=True,is_admin=True); a.set_password('Passw0rd!x'); db.session.add(a)
    for i in range(3): db.session.add(ActivityLog(user_id=None,event_type='page_view',description='x',ip_address='41.66.1.9',location='Unknown',device='Chrome on Windows'))
    db.session.add(ActivityLog(user_id=None,event_type='page_view',description='x',ip_address='10.1.2.3',location='Unknown',device='d'))
    db.session.commit()
c=app.test_client(); tok=c.get('/api/csrf-token').get_json()['csrf_token']
r=c.post('/api/auth/login',json={'username':'boss','password':'Passw0rd!x'},headers={'X-CSRF-Token':tok}); check('admin can sign in',r.status_code==200,r.get_data(as_text=True)[:120])
r=c.get('/api/admin/console/audit?limit=20'); ev=r.get_json()['events']
loc={e['ip']:e['location'] for e in ev if e['ip']}
check('old Unknown row is repaired using the second service', loc.get('41.66.1.9')=='Accra, Ghana', loc)
check('private addresses are labelled, not looked up', loc.get('10.1.2.3')=='Private network' or loc.get('10.1.2.3')=='Unknown', loc.get('10.1.2.3'))
check('the first service was tried before the fallback', any('ipwho.is' in u for u in calls) and any('geojs' in u for u in calls), calls)
n=len(calls); c.get('/api/admin/console/audit?limit=20'); check('repaired rows are stored, so no second lookup', len(calls)==n, calls[n:])
with app.app_context():
    left=ActivityLog.query.filter_by(ip_address='41.66.1.9',location='Unknown').count(); check('database rows were updated', left==0, left)
# ── opt-in precise location ──
def fake2(req,timeout=0):
    url=req.full_url if hasattr(req,'full_url') else req
    if 'nominatim' in url: return R({'address':{'town':'Navrongo','state':'Upper East Region','country':'Ghana'}})
    return fake(req,timeout)
urllib.request.urlopen=fake2
with app.app_context():
    y=User(username='yaw',email='yaw@x.com',is_verified=True,last_ip='41.66.1.9',last_location='Accra, Ghana'); y.set_password('Passw0rd!x'); db.session.add(y); db.session.commit()
c2=app.test_client(); tk=c2.get('/api/csrf-token').get_json()['csrf_token']; H={'X-CSRF-Token':tk}
check('location endpoints need sign-in', c2.get('/api/me/location').status_code==401)
c2.post('/api/auth/login',json={'username':'yaw','password':'Passw0rd!x'},headers=H); H={'X-CSRF-Token':c2.get('/api/csrf-token').get_json()['csrf_token']}
st=c2.get('/api/me/location').get_json(); check('nobody is asked or tracked by default', st['consent'] is False and st['asked'] is False, st)
check('bad coordinates are rejected', c2.post('/api/me/location',json={'lat':'x','lon':1},headers=H).status_code==400 and c2.post('/api/me/location',json={'lat':95,'lon':1},headers=H).status_code==400)
r=c2.post('/api/me/location',json={'lat':10.894567,'lon':-1.092345},headers=H).get_json()
check('sharing returns the town', r.get('place')=='Navrongo, Upper East Region, Ghana', r)
with app.app_context():
    yy=User.query.filter_by(username='yaw').first(); check('coordinates are rounded to ~1 km', (yy.geo_lat,yy.geo_lon)==(10.89,-1.09), (yy.geo_lat,yy.geo_lon))
c=app.test_client(); tok=c.get('/api/csrf-token').get_json()['csrf_token']; c.post('/api/auth/login',json={'username':'boss','password':'Passw0rd!x'},headers={'X-CSRF-Token':tok})
us={u['username']:u for u in c.get('/api/admin/console/users').get_json()['users']}
check('admin Users list shows the shared place as GPS', us['yaw']['location'].startswith('Navrongo') and us['yaw']['loc_src']=='gps', us['yaw'])
ov=c.get('/api/admin/console/overview').get_json()
check('overview lists the shared place and country', any(p['place'].startswith('Navrongo') for p in ov['places']) and any(x['country']=='Ghana' for x in ov['countries']), ov['places'])
det=c.get('/api/admin/console/users/'+us['yaw']['id']).get_json()
check('user detail shows the place', det['user']['location'].startswith('Navrongo'), det['user'])
r=c2.delete('/api/me/location',headers=H); check('user can stop sharing', r.status_code==200)
us={u['username']:u for u in c.get('/api/admin/console/users').get_json()['users']}
check('after stopping, only the network estimate remains', us['yaw']['loc_src']=='ip' and us['yaw']['location'] in ('Local','Accra, Ghana'), us['yaw'])
# ── compulsory sharing ──
os.environ['LOCATION_REQUIRED']='1'
with app.app_context():
    z=User(username='zed',email='zed@x.com',is_verified=True); z.set_password('Passw0rd!x'); db.session.add(z); db.session.commit()
c3=app.test_client(); t3=c3.get('/api/csrf-token').get_json()['csrf_token']
c3.post('/api/auth/login',json={'username':'zed','password':'Passw0rd!x'},headers={'X-CSRF-Token':t3}); H3={'X-CSRF-Token':c3.get('/api/csrf-token').get_json()['csrf_token']}
st=c3.get('/api/me/location').get_json(); check('a new user is told location is required', st['required'] and st['blocked'], st)
r=c3.get('/api/contacts'); check('app data is refused until location is shared', r.status_code==403 and r.get_json().get('code')=='location_required', r.get_data(as_text=True)[:100])
check('signing out still works while blocked', c3.post('/api/auth/logout',headers=H3).status_code==200)
c3.post('/api/auth/login',json={'username':'zed','password':'Passw0rd!x'},headers=H3); H3={'X-CSRF-Token':c3.get('/api/csrf-token').get_json()['csrf_token']}
check('required users cannot switch sharing off', c3.delete('/api/me/location',headers=H3).status_code==403)
c3.post('/api/me/location',json={'lat':10.89,'lon':-1.09},headers=H3)
r=c3.get('/api/contacts'); check('app works once location is shared', r.status_code==200, r.status_code)
with app.app_context():
    zz=User.query.filter_by(username='zed').first(); zz.geo_at=datetime.utcnow()-timedelta(hours=60); db.session.commit()
check('a stale location (over 48 h) blocks again', c3.get('/api/contacts').status_code==403)
check('admins are never locked out', c.get('/api/admin/console/overview').status_code==200 and c.get('/api/me/location').get_json()['blocked'] is False)
os.environ['LOCATION_REQUIRED']='0'; check('the rule can be switched off', c3.get('/api/contacts').status_code==200)
print(f'{sum(res)}/{len(res)} checks passed'); sys.exit(0 if all(res) else 1)
