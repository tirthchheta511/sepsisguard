# SepsisGuard — ICU Sepsis Early Warning

Machine learning that watches ICU patients hour by hour and warns about sepsis before it starts.
Trained on 1.55M hourly records from 40,336 patients (PhysioNet/CinC Challenge 2019) and tested
on a second hospital the model never saw.

- **Model:** LightGBM on 124 leakage-tested time-series signals, SHAP reasons for every alert
- **Results:** AUROC 0.843 (same hospital) and 0.814 (new hospital); catches more sepsis than the SIRS rule with far fewer false alarms
- **App:** FastAPI backend + an interactive report (overview, countdown to sepsis, alert simulator, patient replay, live scoring)

> Research demo on de-identified public data. Not a medical device and not for clinical decisions.

Built by Tirth Chheta.
