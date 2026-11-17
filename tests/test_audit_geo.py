"""Locations in the admin console: provider fallback, reuse of known places, and repair of old 'Unknown' rows."""
import os, sys, tempfile, json, io
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); _tmp=tempfile.mkdtemp(); os.chdir(root); sys.path.insert(0,root)
os.environ['DATABASE_URL']='sqlite:///'+_tmp+'/g.db'; os.environ['FLASK_SECRET']='x'*40; os.environ['ADMIN_2FA_REQUIRED']='0'
import urllib.request
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
print(f'{sum(res)}/{len(res)} checks passed'); sys.exit(0 if all(res) else 1)
