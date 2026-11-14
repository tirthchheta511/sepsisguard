"""SepsisGuard API — ICU sepsis early-warning model.

Endpoints (interactive docs at /docs):
  GET  /api/health              is the server up, which model is loaded
  GET  /api/summary             headline results, Hospital A vs B, alert trade-offs, top signals
  GET  /api/patients            the 24 demo patients (test patients the model never trained on)
  GET  /api/patients/{id}       one patient's hour-by-hour vitals, risk, alerts and reasons
  GET  /api/score/example       a ready-made example request for POST /api/score
  POST /api/score               score a NEW patient live from their hourly measurements
"""
import json
import math
from pathlib import Path
from typing import Literal, Optional

import joblib
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

import sepsisguard_core as core

HERE = Path(__file__).resolve().parent
DATA = HERE / 'data'
DISCLAIMER = ('Research demo on de-identified public data (PhysioNet 2019). '
              'Not a medical device and not for clinical decisions.')

def no_nan(x):
    """JSON can't carry NaN, so turn it into null."""
    if isinstance(x, float) and math.isnan(x):
        return None
    if isinstance(x, dict):
        return {k: no_nan(v) for k, v in x.items()}
    if isinstance(x, list):
        return [no_nan(v) for v in x]
    return x


sm = core.SepsisModel(joblib.load(HERE / 'model' / 'sepsisguard_model.joblib'))
SUMMARY = no_nan(json.loads((DATA / 'summary.json').read_text()))
DEMOS = no_nan(json.loads((DATA / 'demo_patients.json').read_text()))
BY_ID = {d['id']: d for d in DEMOS}

app = FastAPI(title='SepsisGuard API', version='1.0',
              description='Hourly ICU sepsis risk with plain-English reasons. ' + DISCLAIMER)
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['GET', 'POST'], allow_headers=['*'])


def patient_card(d):
    alerts = [h['hour'] for h in d['hours'] if h['risk'] >= d['threshold']]
    return {'id': d['id'], 'kind': d['kind'], 'hospital': d['hospital'], 'age': d['age'], 'sex': d['sex'],
            'icu_type': d['icu_type'], 'hours': len(d['hours']), 'sepsis_onset_hour': d['sepsis_onset_hour'],
            'max_risk': max(h['risk'] for h in d['hours']), 'first_alert_hour': alerts[0] if alerts else None}


@app.get('/api/health')
def health():
    return {'status': 'ok', 'model': sm.bundle['name'], 'version': sm.bundle.get('version', 'v1'),
            'features': len(sm.features), 'thresholds': sm.thresholds, 'demo_patients': len(DEMOS),
            'disclaimer': DISCLAIMER}


@app.get('/api/summary')
def summary():
    return {**SUMMARY, 'disclaimer': DISCLAIMER}


@app.get('/api/patients')
def patients(kind: Optional[str] = None):
    rows = [patient_card(d) for d in DEMOS if not kind or d['kind'] == kind]
    return {'total': len(rows), 'kinds': sorted({d['kind'] for d in DEMOS}), 'items': rows}


@app.get('/api/patients/{pid}')
def patient(pid: str):
    d = BY_ID.get(pid.strip().lower())
    if d is None:
        raise HTTPException(404, f'Unknown demo patient: {pid}')
    return {**patient_card(d), 'threshold': d['threshold'], 'timeline': d['hours'], 'disclaimer': DISCLAIMER}


MEASURES = core.VITALS + core.LABS


class Hour(BaseModel):
    hour: int = Field(..., ge=1, le=2000, description='Hours since ICU admission (1 = first hour)')
    values: dict[str, Optional[float]] = Field(default_factory=dict,
                                               description='Any of: ' + ', '.join(MEASURES))

    @field_validator('values')
    @classmethod
    def known_names(cls, v):
        bad = sorted(set(v) - set(MEASURES))
        if bad:
            raise ValueError(f'Unknown measurement names: {bad}')
        return v


class ScoreRequest(BaseModel):
    age: float = Field(..., ge=14, le=110)
    sex: Literal['male', 'female']
    icu_type: Literal['medical', 'surgical', 'unknown'] = 'unknown'
    hours_in_hospital_before_icu: float = Field(0, ge=0, le=5000)
    hospital: Literal['A', 'B'] = 'A'
    hours: list[Hour] = Field(..., min_length=1, max_length=336)

    @field_validator('hours')
    @classmethod
    def unique_hours(cls, v):
        if len({h.hour for h in v}) != len(v):
            raise ValueError('Each hour can appear only once')
        return v


EXAMPLE = {
    'age': 67, 'sex': 'male', 'icu_type': 'medical', 'hours_in_hospital_before_icu': 12, 'hospital': 'A',
    'hours': [{'hour': h, 'values': {'HR': 82 + 4 * max(0, h - 6), 'Resp': 17 + 1.5 * max(0, h - 6),
                                     'Temp': round(37.0 + 0.25 * max(0, h - 6), 2), 'MAP': 82 - 3 * max(0, h - 6),
                                     'SBP': 124 - 4 * max(0, h - 6), 'O2Sat': 97 - 0.5 * max(0, h - 6),
                                     **({'WBC': 14.5, 'Lactate': 2.6, 'Creatinine': 1.6, 'Platelets': 140} if h == 10 else {})}}
              for h in range(1, 13)]}


@app.get('/api/score/example')
def score_example():
    return EXAMPLE


@app.post('/api/score')
def score(req: ScoreRequest):
    static = {'Age': req.age, 'Gender': 1.0 if req.sex == 'male' else 0.0,
              'Unit1': 1.0 if req.icu_type == 'medical' else (0.0 if req.icu_type == 'surgical' else None),
              'Unit2': 1.0 if req.icu_type == 'surgical' else (0.0 if req.icu_type == 'medical' else None),
              'HospAdmTime': -req.hours_in_hospital_before_icu}
    feat = sm.build_features([{'hour': h.hour, **h.values} for h in req.hours], static)
    risk = sm.score(feat)
    why = sm.reasons(feat)
    thr = sm.thresholds.get(req.hospital, sm.thresholds.get('A'))
    timeline = [{'hour': int(hr), 'risk': round(float(r), 4), 'alert': bool(r >= thr), 'reasons': w}
                for hr, r, w in zip(feat.hour, risk, why)]
    return {'threshold': thr, 'latest': timeline[-1], 'first_alert_hour': next((t['hour'] for t in timeline if t['alert']), None),
            'timeline': timeline, 'disclaimer': DISCLAIMER}



BASELINE = {'HR': 80, 'Resp': 16, 'Temp': 37.0, 'MAP': 85, 'SBP': 125, 'O2Sat': 97}


@app.get('/api/score/quick')
def score_quick(age: float = Query(67, ge=14, le=110), sex: Literal['male', 'female'] = 'male',
                icu_type: Literal['medical', 'surgical', 'unknown'] = 'unknown', hospital: Literal['A', 'B'] = 'A',
                hours_in_hospital_before_icu: float = Query(12, ge=0, le=5000),
                icu_hours: int = Query(24, ge=2, le=336), worse_hours: int = Query(6, ge=1, le=336),
                HR: float = Query(118, ge=20, le=250), O2Sat: float = Query(92, ge=50, le=100),
                MAP: float = Query(63, ge=20, le=200), SBP: float = Query(96, ge=40, le=260),
                Resp: float = Query(27, ge=4, le=70), Temp: float = Query(38.6, ge=30, le=43), labs: bool = False):
    # Same scoring as POST /api/score, but sent as a simple link (GET), so it works behind any proxy.
    # Vitals move in a straight line from normal to the given values over the last `worse_hours` hours.
    now = {'HR': HR, 'O2Sat': O2Sat, 'MAP': MAP, 'SBP': SBP, 'Resp': Resp, 'Temp': Temp}
    worse = min(worse_hours, icu_hours - 1)
    start = icu_hours - worse
    hours = []
    for h in range(1, icu_hours + 1):
        t = 0 if h <= start else (h - start) / worse
        values = {k: round(BASELINE[k] + t * (v - BASELINE[k]), 1) for k, v in now.items()}
        if labs and h == icu_hours:
            values.update(WBC=14.5, Lactate=2.6, Creatinine=1.6, Platelets=140)
        hours.append({'hour': h, 'values': values})
    return score(ScoreRequest(age=age, sex=sex, icu_type=icu_type, hospital=hospital,
                              hours_in_hospital_before_icu=hours_in_hospital_before_icu, hours=hours))

if (HERE / 'static' / 'index.html').exists():
    app.mount('/', StaticFiles(directory=HERE / 'static', html=True), name='site')
else:
    @app.get('/')
    def root():
        return {'message': 'SepsisGuard API is running. Open /docs to try it.', 'disclaimer': DISCLAIMER}
