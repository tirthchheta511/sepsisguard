"""SepsisGuard core — shared by the notebooks AND the web app.
Turns a patient's hourly measurements into the model's 124 features, an hourly risk, and plain-English reasons."""
import duckdb
import numpy as np
import pandas as pd

VITALS = ['HR', 'O2Sat', 'Temp', 'SBP', 'MAP', 'DBP', 'Resp']
LABS = ['EtCO2', 'BaseExcess', 'HCO3', 'FiO2', 'pH', 'PaCO2', 'SaO2', 'AST', 'BUN', 'Alkalinephos', 'Calcium',
        'Chloride', 'Creatinine', 'Bilirubin_direct', 'Glucose', 'Lactate', 'Magnesium', 'Phosphate', 'Potassium',
        'Bilirubin_total', 'TroponinI', 'Hct', 'Hgb', 'PTT', 'WBC', 'Fibrinogen', 'Platelets']
STATIC = ['Age', 'Gender', 'Unit1', 'Unit2', 'HospAdmTime']


def feature_sql(src):
    """Exactly the Phase 4 features. Every feature uses ONLY the current hour and earlier hours."""
    f = []
    for v in VITALS:
        last = f'LAST_VALUE({v} IGNORE NULLS) OVER w_all'
        f += [f'{last} AS {v}_last',
              f'AVG({v}) OVER w6 AS {v}_mean6', f'MIN({v}) OVER w6 AS {v}_min6', f'MAX({v}) OVER w6 AS {v}_max6',
              f'AVG({v}) OVER w24 AS {v}_mean24', f'STDDEV_SAMP({v}) OVER w24 AS {v}_std24',
              f'{last} - LAST_VALUE({v} IGNORE NULLS) OVER w_lag6 AS {v}_change6',
              f'hour - LAST_VALUE(CASE WHEN {v} IS NOT NULL THEN hour END IGNORE NULLS) OVER w_all AS {v}_hrs_since']
    for l in LABS:
        f += [f'LAST_VALUE({l} IGNORE NULLS) OVER w_all AS {l}_last',
              f'hour - LAST_VALUE(CASE WHEN {l} IS NOT NULL THEN hour END IGNORE NULLS) OVER w_all AS {l}_hrs_since']
    n_labs = ' + '.join(f'({l} IS NOT NULL)::INT' for l in LABS)
    f += [f'SUM({n_labs}) OVER w6 AS labs_taken6', f'SUM({n_labs}) OVER w24 AS labs_taken24']
    return f"""
    WITH s1 AS (
      SELECT patient_id, hospital, hour, SepsisLabel, Age, Gender, Unit1, Unit2, HospAdmTime, ICULOS,
             {', '.join(f)}
      FROM {src}
      WINDOW w_all  AS (PARTITION BY patient_id ORDER BY hour ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW),
             w6     AS (PARTITION BY patient_id ORDER BY hour RANGE BETWEEN 5 PRECEDING AND CURRENT ROW),
             w24    AS (PARTITION BY patient_id ORDER BY hour RANGE BETWEEN 23 PRECEDING AND CURRENT ROW),
             w_lag6 AS (PARTITION BY patient_id ORDER BY hour RANGE BETWEEN UNBOUNDED PRECEDING AND 6 PRECEDING)
    ),
    s2 AS (
      SELECT *,
        COALESCE((HR_last > 90)::INT, 0) + COALESCE((Resp_last > 20)::INT, 0)
          + COALESCE((Temp_last > 38 OR Temp_last < 36)::INT, 0) + COALESCE((WBC_last > 12 OR WBC_last < 4)::INT, 0) AS sirs_score,
        COALESCE((Resp_last >= 22)::INT, 0) + COALESCE((SBP_last <= 100)::INT, 0)                                  AS qsofa_partial,
        HR_last / NULLIF(SBP_last, 0)                                                                            AS shock_index,
        (CASE WHEN Platelets_last < 20 THEN 4 WHEN Platelets_last < 50 THEN 3 WHEN Platelets_last < 100 THEN 2
              WHEN Platelets_last < 150 THEN 1 ELSE 0 END)
        + (CASE WHEN Bilirubin_total_last >= 12 THEN 4 WHEN Bilirubin_total_last >= 6 THEN 3
                WHEN Bilirubin_total_last >= 2 THEN 2 WHEN Bilirubin_total_last >= 1.2 THEN 1 ELSE 0 END)
        + (CASE WHEN MAP_last < 70 THEN 1 ELSE 0 END)
        + (CASE WHEN Creatinine_last >= 5 THEN 4 WHEN Creatinine_last >= 3.5 THEN 3
                WHEN Creatinine_last >= 2 THEN 2 WHEN Creatinine_last >= 1.2 THEN 1 ELSE 0 END)           AS sofa_partial,
        BUN_last / NULLIF(Creatinine_last, 0)                                                             AS bun_creatinine_ratio
      FROM s1
    )
    SELECT *, sofa_partial - MIN(sofa_partial) OVER (PARTITION BY patient_id ORDER BY hour
                                                     RANGE BETWEEN 23 PRECEDING AND CURRENT ROW) AS sofa_rise24
    FROM s2"""


BASE_NAMES = {'HR': 'Heart rate', 'O2Sat': 'Oxygen saturation', 'Temp': 'Temperature', 'SBP': 'Systolic BP',
              'MAP': 'Mean BP', 'DBP': 'Diastolic BP', 'Resp': 'Breathing rate', 'WBC': 'White blood cells',
              'BUN': 'BUN (kidney)', 'Creatinine': 'Creatinine (kidney)', 'Bilirubin_total': 'Bilirubin (liver)',
              'Bilirubin_direct': 'Direct bilirubin', 'Platelets': 'Platelets', 'Lactate': 'Lactate', 'Hgb': 'Hemoglobin',
              'Hct': 'Hematocrit', 'FiO2': 'Oxygen given (FiO2)', 'TroponinI': 'Troponin (heart)', 'Glucose': 'Glucose'}
SUFFIX = {'_last': 'latest', '_mean6': '6h average', '_min6': '6h min', '_max6': '6h max', '_mean24': '24h average',
          '_std24': '24h variability', '_change6': 'change vs 6h ago', '_hrs_since': 'hours since last measured'}
SPECIAL = {'ICULOS': 'Hours in ICU', 'HospAdmTime': 'Hours in hospital before ICU', 'Age': 'Age', 'Gender': 'Sex (male)',
           'Unit1': 'Medical ICU', 'Unit2': 'Surgical ICU', 'labs_taken6': 'Lab tests in last 6h',
           'labs_taken24': 'Lab tests in last 24h', 'sirs_score': 'SIRS score', 'qsofa_partial': 'qSOFA score (partial)',
           'shock_index': 'Shock index (HR ÷ SBP)', 'sofa_partial': 'SOFA score (partial)', 'sofa_rise24': 'SOFA rise in 24h',
           'bun_creatinine_ratio': 'BUN ÷ creatinine'}


def nice(f):
    if f in SPECIAL:
        return SPECIAL[f]
    for suf, word in SUFFIX.items():
        if f.endswith(suf):
            return f'{BASE_NAMES.get(f[:-len(suf)], f[:-len(suf)])}, {word}'
    return f


class SepsisModel:
    def __init__(self, bundle):
        self.bundle = bundle
        self.model, self.features = bundle['model'], bundle['features']
        self.thresholds = bundle.get('thresholds', {'A': bundle['threshold']})

    def build_features(self, hours, static):
        """hours: list of dicts with 'hour' plus any measurements; static: Age, Gender, Unit1, Unit2, HospAdmTime."""
        rows = []
        for h in sorted(hours, key=lambda r: r['hour']):
            row = {c: h.get(c) for c in VITALS + LABS}
            row.update({k: static.get(k) for k in STATIC})
            row.update({k: h[k] for k in STATIC if k in h})          # optional per-hour override
            row.update(patient_id='live', hospital='X', hour=int(h['hour']), ICULOS=int(h['hour']), SepsisLabel=0)
            rows.append(row)
        src = pd.DataFrame(rows)
        for c in VITALS + LABS + STATIC:
            src[c] = pd.to_numeric(src[c], errors='coerce').astype('float64')
        con = duckdb.connect()
        con.register('src', src)
        out = con.sql(feature_sql('src') + ' ORDER BY hour').df()
        con.close()
        return out

    def score(self, feat):
        return self.model.predict_proba(feat[self.features].astype('float32'))[:, 1]

    def reasons(self, feat, k=3):
        X = feat[self.features].astype('float32')
        contrib = self.model.predict(X, pred_contrib=True)[:, :-1]
        out = []
        for i in range(len(X)):
            picked = []
            for j in np.argsort(-contrib[i])[:k]:
                if contrib[i, j] <= 0:
                    break
                v = X.iat[i, j]
                picked.append(f"{nice(self.features[j])}: {'not measured' if pd.isna(v) else round(float(v), 1)}")
            out.append(picked)
        return out
