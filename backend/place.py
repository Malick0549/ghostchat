"""
GhostChat · opt-in precise location.

IP lookups cannot be exact: Ghanaian mobile networks, for example, send traffic out through Accra, so
someone in Navrongo appears in Accra. A user can therefore choose to share the location their phone or
browser reports. It is OFF by default, never requested silently (the browser's own Allow prompt is the
final say), rounded to about 1 km before saving, shown to admins only, and removable at any time.
"""
import json
import os
import urllib.request
from datetime import datetime, timedelta

from flask import jsonify, request

FRESH_DAYS = 30        # how long a shared place is still shown to admins
GATE_HOURS = 48        # a shared place older than this no longer unlocks the app
OPEN_PREFIXES = ('/api/auth/', '/api/csrf-token', '/api/me/location', '/api/legal', '/api/status')


def required():
    """Location sharing is compulsory for everyone except admins. Set LOCATION_REQUIRED=0 to switch the rule off."""
    return os.environ.get('LOCATION_REQUIRED', '1') != '0'


def blocked(user):
    at = getattr(user, 'geo_at', None)
    ok = bool(getattr(user, 'geo_consent', False) and at and at >= datetime.utcnow() - timedelta(hours=GATE_HOURS))
    return bool(required() and not getattr(user, 'is_admin', False) and not ok)


def _get_json(url, timeout=3.5):
    req = urllib.request.Request(url, headers={'User-Agent': 'GhostChat-admin/1.0', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def _join(*parts):
    out = []
    for p in parts:
        p = (p or '').strip()
        if p and p not in out:
            out.append(p)
    return ', '.join(out)


def reverse_geocode(lat, lon):
    """Return 'Town, Region, Country' for a rounded point, or the plain numbers if no service answers."""
    tries = (
        (f'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=12&addressdetails=1&lat={lat}&lon={lon}',
         lambda d: (lambda a: _join(a.get('city') or a.get('town') or a.get('village') or a.get('suburb')
                                    or a.get('county'), a.get('state'), a.get('country')))(d.get('address') or {})),
        (f'https://api.bigdatacloud.net/data/reverse-geocode-client?latitude={lat}&longitude={lon}&localityLanguage=en',
         lambda d: _join(d.get('city') or d.get('locality'), d.get('principalSubdivision'), d.get('countryName'))),
    )
    for url, parse in tries:
        try:
            text = parse(_get_json(url))
            if text:
                return text[:190]
        except Exception:
            continue
    return f'{lat:.2f}, {lon:.2f}'


def is_fresh(user):
    at = getattr(user, 'geo_at', None)
    return bool(getattr(user, 'geo_consent', False) and getattr(user, 'geo_place', None) and at
                and at >= datetime.utcnow() - timedelta(days=FRESH_DAYS))


def effective(user):
    """(text, source) – the shared place when fresh, otherwise the IP-based estimate."""
    if is_fresh(user):
        return user.geo_place, 'gps'
    return user.last_location, 'ip'


def install_place(app, db, limiter, require_auth, log_activity=None, User=None):
    from flask import session

    @app.before_request
    def location_gate():
        path = request.path
        if not (User and required() and path.startswith('/api/') and not path.startswith(OPEN_PREFIXES)
                and request.method != 'OPTIONS'):
            return None
        uid = session.get('user_id')
        if not uid or session.get('pending_2fa'):
            return None
        user = db.session.get(User, uid)
        if user and blocked(user):
            return jsonify({'error': 'Turn on location sharing to keep using GhostChat.', 'code': 'location_required',
                            'location_required': True}), 403
        return None
    @app.route('/api/me/location', methods=['GET'])
    def my_location_get():
        user, err = require_auth()
        if err:
            return err
        return jsonify({'consent': bool(user.geo_consent), 'asked': user.geo_consent is not None,
                        'required': required() and not user.is_admin, 'blocked': blocked(user),
                        'place': user.geo_place if user.geo_consent else None,
                        'updated': user.geo_at.isoformat() + 'Z' if user.geo_at else None})

    @app.route('/api/me/location', methods=['POST'])
    @limiter.limit('20 per hour')
    def my_location_set():
        user, err = require_auth()
        if err:
            return err
        data = request.get_json(silent=True) or {}
        try:
            lat, lon = round(float(data.get('lat')), 2), round(float(data.get('lon')), 2)
        except (TypeError, ValueError):
            return jsonify({'error': 'Invalid location'}), 400
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            return jsonify({'error': 'Invalid location'}), 400
        first = not user.geo_consent
        user.geo_lat, user.geo_lon, user.geo_consent = lat, lon, True
        user.geo_place, user.geo_at = reverse_geocode(lat, lon), datetime.utcnow()
        db.session.commit()
        if log_activity and first:
            log_activity(user.id, 'location_shared', 'User chose to share their location')
        return jsonify({'success': True, 'place': user.geo_place})

    @app.route('/api/me/location', methods=['DELETE'])
    def my_location_clear():
        user, err = require_auth()
        if err:
            return err
        if required() and not user.is_admin:
            return jsonify({'error': 'Location sharing is required to use GhostChat.', 'code': 'location_required'}), 403
        user.geo_lat = user.geo_lon = user.geo_place = user.geo_at = None
        user.geo_consent = False
        db.session.commit()
        return jsonify({'success': True})

    @app.route('/api/me/location/decline', methods=['POST'])
    def my_location_decline():
        user, err = require_auth()
        if err:
            return err
        if user.geo_consent is None:
            user.geo_consent = False
            db.session.commit()
        return jsonify({'success': True})
