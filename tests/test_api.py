"""Automated checks for the SepsisGuard API. Run: python -m pytest -q tests"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient  # noqa: E402
from main import app, EXAMPLE  # noqa: E402

client = TestClient(app)


def test_health():
    body = client.get('/api/health').json()
    assert body['status'] == 'ok' and body['features'] > 100


def test_summary_has_results():
    body = client.get('/api/summary').json()
    for key in ['model', 'test_results', 'operating_points', 'recalibration', 'tradeoff_curves', 'top_signals']:
        assert key in body


def test_patient_list_and_filter():
    body = client.get('/api/patients').json()
    assert body['total'] == len(body['items']) > 0
    kind = body['items'][0]['kind']
    assert all(p['kind'] == kind for p in client.get('/api/patients', params={'kind': kind}).json()['items'])


def test_patient_detail_and_unknown():
    pid = client.get('/api/patients').json()['items'][0]['id']
    body = client.get(f'/api/patients/{pid}').json()
    assert body['id'] == pid and len(body['timeline']) == body['hours']
    assert all(0 <= h['risk'] <= 1 for h in body['timeline'])
    assert client.get('/api/patients/demo-999').status_code == 404


def test_live_score_example():
    body = client.post('/api/score', json=EXAMPLE).json()
    assert len(body['timeline']) == len(EXAMPLE['hours'])
    assert all(0 <= t['risk'] <= 1 for t in body['timeline'])
    assert body['latest']['hour'] == max(h['hour'] for h in EXAMPLE['hours'])


def test_live_score_rejects_bad_input():
    bad_name = {**EXAMPLE, 'hours': [{'hour': 1, 'values': {'NotAVital': 5}}]}
    assert client.post('/api/score', json=bad_name).status_code == 422
    dup = {**EXAMPLE, 'hours': [{'hour': 1, 'values': {}}, {'hour': 1, 'values': {}}]}
    assert client.post('/api/score', json=dup).status_code == 422
    assert client.post('/api/score', json={**EXAMPLE, 'age': 3}).status_code == 422


def test_scoring_ignores_future_hours():
    """The risk at hour 6 must be the same whether or not later hours are sent (no peeking ahead)."""
    first6 = {**EXAMPLE, 'hours': [h for h in EXAMPLE['hours'] if h['hour'] <= 6]}
    a = client.post('/api/score', json=first6).json()['timeline'][-1]['risk']
    b = next(t['risk'] for t in client.post('/api/score', json=EXAMPLE).json()['timeline'] if t['hour'] == 6)
    assert abs(a - b) < 1e-9


def test_quick_score_matches_post():
    q = {'age': 67, 'sex': 'male', 'icu_type': 'medical', 'hospital': 'A', 'icu_hours': 12, 'worse_hours': 6,
         'HR': 118, 'O2Sat': 92, 'MAP': 63, 'SBP': 96, 'Resp': 27, 'Temp': 38.6, 'labs': True}
    a = client.get('/api/score/quick', params=q)
    assert a.status_code == 200 and len(a.json()['timeline']) == 12
    base = {'HR': 80, 'Resp': 16, 'Temp': 37.0, 'MAP': 85, 'SBP': 125, 'O2Sat': 97}
    hours = []
    for h in range(1, 13):
        t = 0 if h <= 6 else (h - 6) / 6
        vals = {k: round(base[k] + t * (q[k] - base[k]), 1) for k in base}
        if h == 12:
            vals.update(WBC=14.5, Lactate=2.6, Creatinine=1.6, Platelets=140)
        hours.append({'hour': h, 'values': vals})
    b = client.post('/api/score', json={'age': 67, 'sex': 'male', 'icu_type': 'medical', 'hospital': 'A',
                                        'hours_in_hospital_before_icu': 12, 'hours': hours}).json()
    assert [t['risk'] for t in a.json()['timeline']] == [t['risk'] for t in b['timeline']]
    assert client.get('/api/score/quick', params={**q, 'HR': 999}).status_code == 422
