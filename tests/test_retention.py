import os, sys, sqlite3, uuid, json
from datetime import datetime, timedelta
import tempfile
root=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); _tmp=tempfile.mkdtemp(); os.chdir(root); sys.path.insert(0,root)
os.environ['DATABASE_URL']='sqlite:///'+_tmp+'/ret.db'; os.environ['FLASK_SECRET']='x'*40; os.environ['LOG_RETENTION_DAYS']='180'
if os.path.exists(_tmp+'/ret.db'): os.remove(_tmp+'/ret.db')
import flask_app
app=flask_app.app
res=[]
def check(n,ok,info=''): res.append(ok); print(('PASS' if ok else 'FAIL'),'-',n,info if not ok else '')
from backend.models import db, User, ActivityLog, UserSession
now=datetime.utcnow()
with app.app_context():
    u=User(username='ret1',email='ret1@x.com',password_hash='x'); db.session.add(u); db.session.flush()
    u.verification_code='123456'; u.verification_code_expires=now-timedelta(hours=1)
    u.two_factor_code='654321'; u.two_factor_code_expires=now-timedelta(minutes=5)
    u.reset_token='tok'; u.reset_token_expires=now-timedelta(days=2)
    u2=User(username='ret2',email='ret2@x.com',password_hash='x'); db.session.add(u2); db.session.flush()
    u2.verification_code='999999'; u2.verification_code_expires=now+timedelta(minutes=10)
    u2.two_factor_code='111111'; u2.two_factor_code_expires=now+timedelta(minutes=5)
    u2.reset_token='live'; u2.reset_token_expires=now+timedelta(hours=3)
    for days in (400,181,179,10,0):
        db.session.add(ActivityLog(user_id=u.id,event_type='login',description=f'{days}d old',ip_address='1.2.3.4',created_at=now-timedelta(days=days)))
    db.session.add(UserSession(user_id=u.id,session_token='old',expires_at=now-timedelta(days=40)))
    db.session.add(UserSession(user_id=u.id,session_token='recent',expires_at=now-timedelta(days=2)))
    db.session.add(UserSession(user_id=u.id,session_token='live',expires_at=now+timedelta(days=1)))
    from backend.moderation import Report
    for st,days in (('open',500),('actioned',400),('actioned',30),('dismissed',366)):
        db.session.add(Report(reporter_id='r',reported_id='x',reason='spam',status=st,resolved_at=None if st=='open' else now-timedelta(days=days),created_at=now-timedelta(days=days)))
    db.session.commit()
    before=ActivityLog.query.filter_by(user_id=u.id).count()
    out=app.extensions['gc_prune'](); db.session.expire_all()
    print('removed:',out)
    left=sorted(int(l.description.split('d')[0]) for l in ActivityLog.query.filter_by(user_id=u.id,event_type='login').all())
    check('log entries older than 180 days are deleted, newer kept',left==[0,10,179],left)
    check('sessions: 40-day-old expired one removed; recent and live kept',sorted(s.session_token for s in UserSession.query.filter_by(user_id=u.id).all())==['live','recent'])
    check('expired codes and reset link are cleared',all(getattr(db.session.get(User,u.id),f) is None for f in ('verification_code','two_factor_code','reset_token')))
    check('codes that are still valid are NOT touched',all(getattr(db.session.get(User,u2.id),f) for f in ('verification_code','two_factor_code','reset_token')))
    reps=sorted((r.status,(now-r.created_at).days) for r in Report.query.all())
    check('open reports are never deleted; old closed ones are; recent closed ones stay',reps==[('actioned',30),('open',500)],reps)
    out2=app.extensions['gc_prune'](); check('running again is harmless (nothing more to delete)',not any(out2.values()),out2)
print(sum(res),'/',len(res))
