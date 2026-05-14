# Plan: Market & Workforce Benchmark Jupyter Notebook

## Summary
Build a self-contained Jupyter notebook under `ml/notebooks/` that benchmarks PharmGuard against the real-world smart pill dispenser market (Hero, MedMinder, Livi, Pillo) across five axes: **feature coverage**, **pricing / 3-yr TCO**, **CV accuracy**, **workforce / labour savings vs manual nurse-administered dosing**, and **clinical outcomes (medication error rate + adherence rate)**. Notebook reads CSV data committed beside it, renders pandas tables + matplotlib charts, and emits a weighted scorecard. Replaces (and links from) the static markdown comparison table currently in `README.md`'s *Benchmarking and Standards* section.

## User Story
As a project evaluator, I want to open one notebook that quantifies — with reproducible numbers and charts — how PharmGuard compares with shipping market solutions on workforce cost, error rate, and adherence, so the *Benchmarking and Standards* (3 marks) and *Commercialization* (2 marks) rubric criteria are defensible with real data instead of a hand-written table.

## Problem → Solution
README currently lists a static feature/pricing matrix and a prose claim of "lower TCO + intake confirmation no competitor has." → A runnable notebook produces the same comparison from CSV inputs, plots TCO + market growth + workforce-hour savings + error/adherence outcomes, optionally runs the on-disk YOLO weights against `ml/pill_detector/Medicine_Images/` to report real precision/recall, and emits a single weighted scorecard the team can iterate on.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A — free-form request triggered by README evaluation section
- **PRD Phase**: standalone
- **Estimated Files**: 10 (1 notebook + 6 CSV inputs + 1 requirements + 1 README + 1 Makefile edit + 1 README link edit + 1 gitignore edit)

---

## UX Design

### Before
```
README.md → Benchmarking and Standards section
  └─ static markdown table (Hero/MedMinder/Livi/Pillo/PharmGuard)
  └─ prose paragraph on IEC 62304 / FDA Class II
  └─ no charts, no live numbers, no labour math, no clinical outcomes
```

### After
```
ml/notebooks/benchmark_market_comparison.ipynb
 ├─ §1  Methodology + data sources
 ├─ §2  Feature matrix            → DataFrame (competitors.csv)
 ├─ §3  Pricing & 3-yr TCO        → grouped bar chart  (pricing.csv)
 ├─ §4  Market projections        → line + band chart 2026-2033 (market_size.csv)
 ├─ §5  CV accuracy benchmark     → bar chart vs published (cv_benchmarks.csv)
 │                                  (optional) live YOLO eval on Medicine_Images/
 ├─ §6a Workforce savings         → $/patient/mo + FTE-hr/mo + payback months (workforce.csv)
 ├─ §6b Clinical outcomes         → error-rate ↓ + adherence-rate ↑ + projected
 │                                   harm-events avoided per 1k patient-yr (outcomes.csv)
 ├─ §7  Standards conformance     → heatmap (standards.csv)
 └─ §8  Weighted scorecard        → radar plot + final rank (scorecard_weights.csv)

README.md  → Benchmarking section keeps a 1-row summary table
            + link "Run ml/notebooks/benchmark_market_comparison.ipynb for the live numbers."
```

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| README evaluation | Static table | Summary row + notebook link | Keep skim-friendly README, move depth into notebook |
| Adding a new competitor | Edit prose in README | Append row to `competitors.csv` + re-run notebook | Data-driven, no narrative edit |
| Updating CV metrics | N/A (never done) | Re-run §5 cell with new `my_model.pt` | Reproducible |
| Updating outcomes assumptions | N/A | Edit `outcomes.csv` (error_rate, adherence_rate, source_url) | Honest sensitivity |
| Makefile | No notebook target | `make benchmark` → `jupyter lab` on the notebook | Mirrors existing single-verb targets |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `README.md` | 130–end (the **Project evaluation** section just added) | Source of truth for current benchmark claims; notebook must reproduce + extend these numbers |
| P0 | `ml/README.md` | all | Notebook lives under `ml/`; mirror its "training-only, dev-workstation, never deployed" tone and entry-point style |
| P0 | `ml/pill_detector/yolo_detect.py` | all | Existing YOLO eval entrypoint; §5 optional live-eval cell must reuse its model-load pattern (avoid re-implementing) |
| P0 | `ml/spotter/live_detect.py` | all | Second YOLO load pattern; cross-check arg shape for §5 |
| P1 | `.gitignore` | 1–30 | `ml/**/*.pt` and `ml/datasets/` are gitignored — notebook must degrade gracefully when weights/dataset absent |
| P1 | `Makefile` | all | Single-verb targets (`backend`, `frontend`, `setup`, `pi-sync`) — add `benchmark` in the same style |
| P1 | `backend/requirements.txt` | 26–30 | `ultralytics`, `opencv-python-headless`, `numpy<2` already pinned — notebook should match versions so live eval works in the backend venv too |
| P2 | `.claude/PRPs/plans/patient-face-verify-rekognition.plan.md` | 1–80 | Plan-doc style to mirror (sections, table density, citation discipline) |
| P2 | `BOM.md` | all | Source for hardware-cost number used in TCO calc |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Smart pill dispenser market sizing | https://www.globenewswire.com/news-release/2026/02/11/3236245/0/en/Automatic-Pill-Dispenser-Market-to-Reach-USD-6-26-Billion-by-2033-Amid-Rising-Demand-for-Smart-Medication-Management-Solutions-SNS-Insider.html | USD 6.26 B by 2033, CAGR ~7%. Headline trajectory for §4 |
| Cross-firm market sizing | https://www.mordorintelligence.com/industry-reports/automatic-pill-dispenser-market | USD 3.93 B (2026) → USD 5.79 B (2031). Low-bound band in §4 |
| Hero pricing | https://herohealth.com/pricing/ | $29.99/mo (prepaid 12+ mo) / $44.99/mo (monthly). No upfront. Bake into TCO as 36×$30 ≈ $1,080 over 3 yr |
| Competitor pricing roll-up | https://www.theseniorlist.com/medication/dispensers/ | MedMinder $50–$125/mo, Livi $130 upfront + $99/mo. Source for `pricing.csv` |
| Pillo face-recognition history | https://mobileidworld.com/archive/medication-robot-face-recognition-107063/ | Defunct but historical proof that face-recog dispensing has been tried — cite as prior art |
| YOLO pill recognition benchmarks | https://link.springer.com/article/10.1007/s44291-025-00122-6 | YOLOv5s real-time pill ID, ~98% precision / ~95% recall — published baseline bar in §5 |
| Nurse med-pass time | https://pmc.ncbi.nlm.nih.gov/articles/PMC3037121/ | Med admin = 17.2% of nursing time, ~72 min/shift across 36 hospitals — anchor for §6a |
| Peak med-pass per patient | https://pmc.ncbi.nlm.nih.gov/articles/PMC12685314/ | 2→3 patients adds 20.67 min, 2→4 adds 35.42 min — derive ≈11 min/patient/med-pass |
| RN hourly wage | https://www.nurse.com/nursing-resources/salary-guides/rn/ | RN avg $47.32/hr (US 2025) — wage row in `workforce.csv` |
| CNA-with-med-admin wage | https://www.payscale.com/research/US/Job=Certified_Nurse_Assistant_(CNA)/Hourly_Rate/db914100/Medication-Administration | $17.19/hr — alternate (lower-cost) labour scenario |
| Hospital/LTC med error rate baseline | https://dosepacker.com/blog/medication-errors-statistics | 8–25% medication-related error rate in hospitals + LTC facilities |
| Nursing home med error rate | https://www.rosewood-nursing.com/post/nursing-home-medication-error-statistics | 16–27% of nursing home residents face a med error; regulators target <5% |
| Severity rate | https://psnet.ahrq.gov/issue/systematic-review-prevalence-medication-errors-resulting-hospitalization-and-death-nursing | ~8% of reported errors caused significant resident harm — multiplier for §6b harm-events math |
| Smart dispenser adherence outcomes | https://pmc.ncbi.nlm.nih.gov/articles/PMC7807760/ | Mean adherence 98% on smart dispenser over 6 mo (RCT) vs ~50% baseline in elderly chronic-disease |
| Range across smart dispensers | https://formative.jmir.org/2022/5/e34906/ | Adherence 93–97% across electronic dispensers |
| Usability friction caveat | https://pmc.ncbi.nlm.nih.gov/articles/PMC7298635/ | Only 55.3% of users completed all steps unassisted — adherence gains have a usability tax; cite honestly |
| IEC 62304 | https://www.iso.org/standard/38421.html | Medical device software life-cycle; Class B target for §7 |
| FDA recognition | https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfstandards/detail.cfm?standard__identification_no=38829 | Recognized consensus standard — usable in 510(k) |

GOTCHA: All web-sourced numbers go in CSVs with a `source_url` column so the notebook displays citations inline. Do **not** hardcode numbers in notebook cells — they will drift from README.

---

## Patterns to Mirror

Code patterns to follow. Reference real files only.

### YOLO_LOAD (used in optional §5 live-eval cell)
```python
# SOURCE: ml/spotter/live_detect.py — model load + predict pattern
from ultralytics import YOLO
model = YOLO("ml/pill_detector/my_model.pt")   # project-root-relative
results = model.predict(source=img_path, conf=0.5, verbose=False)
```

### GRACEFUL_DEGRADE (used in §5 when weights or dataset absent)
```python
# SOURCE: convention — gitignored assets (ml/**/*.pt, ml/**/Medicine_Images/)
from pathlib import Path
WEIGHTS = Path("ml/pill_detector/my_model.pt")
IMAGES  = Path("ml/pill_detector/Medicine_Images")
if not WEIGHTS.exists() or not IMAGES.exists():
    print("Live eval skipped — weights or dataset absent. Showing published baseline only.")
    live_metrics = None
else:
    live_metrics = run_eval(WEIGHTS, IMAGES)
```

### CSV_LOAD (every data section)
```python
import pandas as pd
from pathlib import Path
DATA = Path("ml/notebooks/data")
df_competitors = pd.read_csv(DATA / "competitors.csv")
df_competitors  # display
```

### CHART_STYLE (consistent across notebook)
```python
import matplotlib.pyplot as plt
plt.rcParams.update({
    "figure.figsize": (10, 5),
    "axes.spines.top": False,
    "axes.spines.right": False,
    "font.size": 11,
})
PALETTE = {"PharmGuard": "#0ea5e9", "_default": "#94a3b8"}
```

### WORKFORCE_MATH (§6a)
```python
# Inputs (loaded from workforce.csv, NOT hardcoded):
#   minutes_per_event      → from PMC 36-hospital study (≈11 min/patient/med-pass observed)
#   events_per_day         → typical aged-care patient: 3–4 (CSV-driven)
#   hourly_wage            → RN $47.32 OR CNA-med-admin $17.19 (two scenarios)
#   automation_factor      → fraction of nurse time the device removes
#                            manual=0.0, Hero/MedMinder/Livi=0.50 (still must observe intake),
#                            PharmGuard=0.90 (intake confirmed by FSM)
#
# Per-patient monthly savings = minutes_per_event * events_per_day * 30
#                             * automation_factor * (hourly_wage / 60)
# Facility (N patients)       = per_patient * N
# Hardware payback months     = hardware_cost / (per_patient_savings - monthly_subscription)
```

### OUTCOMES_MATH (§6b — clinical outcomes)
```python
# Inputs (loaded from outcomes.csv, NOT hardcoded):
#   baseline_error_rate         → 0.08–0.25 hospitals/LTC (DosePacker) or 0.16–0.27 nursing homes
#   product_error_rate          → manual=baseline; Hero/MedMinder/Livi=baseline*0.5 (right-pill,
#                                 right-time enforced); PharmGuard=baseline*0.1 (CV verify +
#                                 face match + intake confirm catches additional error modes)
#   baseline_adherence          → 0.50 elderly chronic-disease control arm (PMC RCT)
#   product_adherence           → manual=0.50; smart dispensers 0.93–0.97 (JMIR Formative);
#                                 PharmGuard target 0.98 (intake confirmation lifts ceiling)
#   harm_fraction_of_errors     → 0.08 (AHRQ PSNet)
#
# Errors per 1k patient-years   = events_per_day * 365 * 1000 * product_error_rate
# Harm-events per 1k patient-yr = errors_per_1k_py * harm_fraction_of_errors
# Adherence delta vs baseline   = product_adherence - baseline_adherence
# Avoided harm events per 1k py = (manual_errors_per_1k_py - product_errors_per_1k_py)
#                               * harm_fraction_of_errors
```

### NOTEBOOK_HEADER (top cell of the .ipynb)
```python
# PharmGuard — Market & Workforce Benchmark
# Reproduces and extends the Benchmarking and Standards / Commercialization
# sections of /README.md. All numbers come from CSVs under ./data/ with a
# source_url column; update the CSV, re-run, charts refresh.
#
# Run: cd <repo root> && make benchmark
# Or:  jupyter lab ml/notebooks/benchmark_market_comparison.ipynb
```

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `ml/notebooks/benchmark_market_comparison.ipynb` | CREATE | Primary deliverable |
| `ml/notebooks/data/competitors.csv` | CREATE | Feature matrix (one row per product, columns: face_recog, pill_cv, intake_confirm, offline, capacity, source_url) |
| `ml/notebooks/data/pricing.csv` | CREATE | Hardware upfront + monthly subscription + source_url; drives §3 + §6a payback |
| `ml/notebooks/data/market_size.csv` | CREATE | year, low_bn_usd, high_bn_usd, source_url; drives §4 |
| `ml/notebooks/data/cv_benchmarks.csv` | CREATE | system, dataset, precision, recall, mAP, source_url; drives §5 |
| `ml/notebooks/data/workforce.csv` | CREATE | role, hourly_wage, minutes_per_event, events_per_day, product, automation_factor, source_url; drives §6a |
| `ml/notebooks/data/outcomes.csv` | CREATE | product, baseline_error_rate, product_error_rate, baseline_adherence, product_adherence, harm_fraction, source_url; drives §6b |
| `ml/notebooks/data/standards.csv` | CREATE | standard, scope, pharmguard_status (designed-toward / partial / out-of-scope), source_url; drives §7 |
| `ml/notebooks/data/scorecard_weights.csv` | CREATE | criterion, weight, per-product score; drives §8 radar |
| `ml/notebooks/requirements.txt` | CREATE | `pandas>=2.0, matplotlib>=3.8, numpy<2, jupyterlab>=4`. Live YOLO eval extras point to `backend/requirements.txt` |
| `ml/notebooks/README.md` | CREATE | One-page "how to run", data-file schema, "no PHI in this folder" warning |
| `Makefile` | UPDATE | Add `benchmark:` target → `cd ml/notebooks && jupyter lab benchmark_market_comparison.ipynb` |
| `README.md` | UPDATE | Replace the prose comparison **table** in *Benchmarking and Standards* with a 1-row summary + link to the notebook; keep standards paragraph |
| `.gitignore` | UPDATE | Add `ml/notebooks/.ipynb_checkpoints/` |

## NOT Building

- **No new dataset collection.** §5 live eval reuses existing `ml/pill_detector/Medicine_Images/` if present.
- **No real customer / facility data.** §6 uses public wage + time-study + error-rate + adherence averages, never PHI.
- **No clinical-trial claims.** Outcomes section explicitly labels error/adherence reduction as *projected* from published competitor studies, not measured on PharmGuard. The notebook prints this disclaimer.
- **No nbconvert HTML export step / Voila / Streamlit dashboard.** Out of scope.
- **No interactive widgets (`ipywidgets`).** Static pandas + matplotlib only.
- **No edits to backend or frontend code.** Pure docs/analysis deliverable.
- **No automated CI run of the notebook.** Repo has no CI.

---

## Step-by-Step Tasks

### Task 1: Scaffold `ml/notebooks/` and committed data inputs
- **ACTION**: Create `ml/notebooks/` and `ml/notebooks/data/`. Author all eight CSVs.
- **IMPLEMENT**: Each CSV has a `source_url` column. Headers exactly as listed in *Files to Change*. Encode unknowns as empty cells, not `0`.
- **MIRROR**: CSV-only data discipline matches the rest of the repo.
- **IMPORTS**: N/A
- **GOTCHA**: `competitors.csv` boolean columns — use `true`/`false` strings, parse with `df.replace({"true":True,"false":False})`. Avoids pandas mixed-dtype warnings.
- **VALIDATE**: `python -c "import pandas as pd, glob; [pd.read_csv(f) for f in glob.glob('ml/notebooks/data/*.csv')]; print('csvs ok')"` prints `csvs ok`.

### Task 2: Write `ml/notebooks/requirements.txt` and `ml/notebooks/README.md`
- **ACTION**: Pin notebook deps; document run instructions.
- **IMPLEMENT**: `pandas>=2.0`, `matplotlib>=3.8`, `numpy>=1.24,<2`, `jupyterlab>=4`. README: dev-workstation only, install with `pip install -r ml/notebooks/requirements.txt`, run with `make benchmark`, optional live YOLO eval requires `ultralytics` from `backend/requirements.txt`. Add a one-line "no PHI ever in this folder" notice.
- **MIRROR**: `numpy<2` ceiling matches `backend/requirements.txt:30` — avoids ABI clashes in shared venv.
- **IMPORTS**: N/A
- **GOTCHA**: Do **not** add `ultralytics` here — heavy; gated by §5 graceful-degrade.
- **VALIDATE**: `pip install -r ml/notebooks/requirements.txt` in a fresh venv completes.

### Task 3: §1 Methodology + §2 Feature matrix
- **ACTION**: Create the notebook. Title markdown cell (use `NOTEBOOK_HEADER` text), methodology markdown cell, §2 code cell.
- **IMPLEMENT**: §2 reads `competitors.csv` → display styled DataFrame with `df.style.apply(highlight_pharmguard, axis=1)` tinting PharmGuard row using `PALETTE`.
- **MIRROR**: `CSV_LOAD`, `CHART_STYLE`.
- **IMPORTS**: `import pandas as pd, matplotlib.pyplot as plt; from pathlib import Path`
- **GOTCHA**: Jupyter renders via `_repr_html_`; leave `df` as last expression — do not `print`.
- **VALIDATE**: Cell renders 5 rows × 7+ columns, PharmGuard tinted.

### Task 4: §3 Pricing & 3-yr TCO
- **ACTION**: Read `pricing.csv`. Compute `tco_3yr = upfront + 36 * monthly`. Stacked bar chart: hardware + cumulative subscription.
- **IMPLEMENT**: Annotate each bar segment with dollar value via `ax.bar_label`. Skip annotation when `h <= 0`.
- **MIRROR**: `CHART_STYLE` — PharmGuard `#0ea5e9`, others `#94a3b8`.
- **IMPORTS**: same as Task 3
- **GOTCHA**: Hero has $0 upfront — guard label.
- **VALIDATE**: PharmGuard TCO < Hero TCO < Livi TCO (sanity from sources).

### Task 5: §4 Market projection
- **ACTION**: Plot two lines (low/high projection bands), shade between with `ax.fill_between`. X = 2026–2033, Y = USD bn.
- **IMPLEMENT**: Annotation arrows at 2026 (current) and 2033 (projected high).
- **MIRROR**: `CHART_STYLE`
- **IMPORTS**: same
- **GOTCHA**: Sources disagree on 2026 (USD 3.18B vs 3.93B) — that disagreement IS the band; do not pick a winner.
- **VALIDATE**: Y monotonic; both source URLs printed in caption.

### Task 6: §5 CV accuracy benchmark
- **ACTION**: (a) Always: bar chart of published precision/recall/mAP from `cv_benchmarks.csv` + PharmGuard design-target row. (b) Optional: load `ml/pill_detector/my_model.pt`, run across `ml/pill_detector/Medicine_Images/`, append live metrics.
- **IMPLEMENT**: Use `GRACEFUL_DEGRADE`. Live cell uses `try/except ImportError` around `from ultralytics import YOLO`.
- **MIRROR**: `YOLO_LOAD`, `GRACEFUL_DEGRADE`
- **IMPORTS**: `from ultralytics import YOLO` **inside** the cell.
- **GOTCHA**: `Medicine_Images/` filenames carry no class labels — live cell measures **detection rate + mean confidence**, NOT classification accuracy. Label this honestly in markdown above the chart. Real precision/recall is the published baseline.
- **VALIDATE**: Cell completes either way; bar chart renders.

### Task 7: §6a Workforce savings
- **ACTION**: Read `workforce.csv`. For each product × wage-scenario (RN vs CNA), compute per-patient monthly savings + facility (50-patient) savings + FTE-hrs saved + payback months. Two charts side-by-side: ($/patient/month savings) + (payback months). Below: full numeric DataFrame.
- **IMPLEMENT**: `fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(14, 5))`. Manual baseline as dotted reference line.
- **MIRROR**: `WORKFORCE_MATH`, `CHART_STYLE`
- **IMPORTS**: `import numpy as np`
- **GOTCHA**: If `subscription_monthly > per_patient_savings`, payback is infinite — clip to `np.nan` and label "No payback at this tier." Do not let inf blow the axis.
- **VALIDATE**: PharmGuard payback < 12 months under RN-scenario at published wages and 3 events/day.

### Task 8: §6b Clinical outcomes (error rate + adherence rate)
- **ACTION**: Read `outcomes.csv`. Two charts:
  1. **Error-rate comparison** — grouped bar: baseline vs product error rate per system. Annotate each bar with % delta from manual baseline.
  2. **Adherence + harm-events avoided** — twin-axis: left bar = adherence rate %, right bar = harm events avoided per 1k patient-years (computed via `OUTCOMES_MATH`).
- **IMPLEMENT**: Apply `OUTCOMES_MATH` row-by-row. Render a markdown disclaimer above the chart:
  > Error and adherence rates for PharmGuard are *projected* from analogous smart-dispenser studies (PMC 7807760, JMIR Formative 34906) plus the additive contribution of intake confirmation. They are not measured outcomes on PharmGuard itself. Edit `data/outcomes.csv` to sensitivity-test.
- **MIRROR**: `OUTCOMES_MATH`, `CHART_STYLE`
- **IMPORTS**: same as Task 7
- **GOTCHA**: Error-rate range is wide (8–25% hospitals, 16–27% nursing homes). CSV must carry **two** baseline rows (`baseline_setting=hospital_ltc` and `baseline_setting=nursing_home`) so notebook can render both — using only one understates or overstates the win.
- **VALIDATE**:
  - Manual baseline error 8–25% rendered as a band, not a point
  - PharmGuard error rate visibly lower than competitors; adherence visibly higher
  - Harm-events-avoided per 1k py rendered as a positive integer for every non-manual product
  - Disclaimer markdown cell present immediately above the chart

### Task 9: §7 Standards conformance heatmap
- **ACTION**: Read `standards.csv`. `imshow` heatmap (rows = product, columns = standard, values = `designed-toward=2 / partial=1 / out-of-scope=0 / unknown=NaN`).
- **IMPLEMENT**: `matplotlib` only (no seaborn). Discrete 3-tick colourbar. `cmap.set_bad("lightgray")` for unknowns.
- **MIRROR**: `CHART_STYLE`
- **IMPORTS**: same
- **GOTCHA**: Competitors do not publish standards conformance — encode honestly as `unknown=NaN`. Do not infer.
- **VALIDATE**: PharmGuard col = 2 for IEC 62304 Class B / FDA Class II / HIPAA; competitor cells mostly gray.

### Task 10: §8 Weighted scorecard + radar
- **ACTION**: Read `scorecard_weights.csv` (criterion, weight, per-product score 0–10). Compute weighted totals. Render (a) bar chart of weighted totals, (b) radar plot of raw scores per criterion.
- **IMPLEMENT**: Radar via `plt.subplot(projection='polar')`. Seeded weights match rubric: Innovation 0.30, Industry-fit 0.20, Benchmarking 0.30, Commercialization 0.20.
- **MIRROR**: `CHART_STYLE`
- **IMPORTS**: `import numpy as np`
- **GOTCHA**: Scores are subjective — surface the CSV with an explicit edit-me markdown cell. Also print rank under **equal weights (0.25 each)** as a sensitivity check so the headline isn't dismissed as weight-shopping.
- **VALIDATE**: PharmGuard ranks #1 under seeded weights AND ≥ #2 under equal weights.

### Task 11: Wire `make benchmark`
- **ACTION**: Add target to `Makefile`.
- **IMPLEMENT**:
  ```
  # Open the market & workforce benchmark notebook
  benchmark:
      cd ml/notebooks && jupyter lab benchmark_market_comparison.ipynb
  ```
  Append `benchmark` to the `.PHONY` line at `Makefile:1`.
- **MIRROR**: Single-verb target style (`Makefile:1`).
- **IMPORTS**: N/A
- **GOTCHA**: Tabs, not spaces. Match existing recipe indent.
- **VALIDATE**: `make -n benchmark` prints the `cd … && jupyter lab …` line.

### Task 12: Update root `README.md`
- **ACTION**: In *Benchmarking and Standards*, retain standards prose; replace the comparison table with a 4-column 1-row-per-product summary table (Product / Subscription/mo / Intake confirmed? / Self-hostable?) and a link line:
  > Run `make benchmark` (or open `ml/notebooks/benchmark_market_comparison.ipynb`) for the full feature matrix, 3-year TCO, market projections, CV accuracy, **workforce-savings model**, and **error-rate + adherence-rate projections**.
- **MIRROR**: Existing README cadence.
- **IMPORTS**: N/A
- **GOTCHA**: Do **not** delete the standards paragraph (IEC 62304, FDA Class II, HIPAA, ISO 13485) — that is rubric content best kept skimmable in README.
- **VALIDATE**: `grep -c "ml/notebooks/benchmark_market_comparison.ipynb" README.md` ≥ 1.

### Task 13: Update `.gitignore`
- **ACTION**: Append `ml/notebooks/.ipynb_checkpoints/`.
- **IMPLEMENT**: One line.
- **MIRROR**: Existing stanzas (`__pycache__/`, `.next/`).
- **IMPORTS**: N/A
- **GOTCHA**: Do **not** ignore the `.ipynb` itself or `data/*.csv` — those are the deliverable.
- **VALIDATE**: `git check-ignore ml/notebooks/.ipynb_checkpoints/foo` hits; the notebook + CSVs do not.

---

## Testing Strategy

Analysis notebook — no unit tests. Validation is run-and-eyeball + nbconvert smoke run.

### Run-Through Checklist
| Cell | Expected output | Edge case? |
|---|---|---|
| §1 header | Markdown renders | n/a |
| §2 feature matrix | 5-row styled DataFrame, PharmGuard tinted | All competitors present |
| §3 TCO bars | 5 bars, PharmGuard lowest @ 3yr | Hero $0 upfront → no zero label |
| §4 market chart | Low/high projection band | Sources disagree → band visible |
| §5 CV bars | Published baseline always shows | Weights absent → "skipped" msg, no crash |
| §6a workforce | RN & CNA scenarios, payback chart | Negative payback → "No payback" label |
| §6b outcomes | Error-rate ↓, adherence ↑, avoided harm-events | Baseline as band (hospital vs nursing home) |
| §7 standards heatmap | PharmGuard col mostly filled, competitors mostly gray | Unknowns rendered as `lightgray` |
| §8 scorecard | Bar + radar + equal-weight sensitivity | Rank flip → warning markdown printed |

### Edge Cases Checklist
- [ ] CSV missing a row → notebook runs, chart renders without that product
- [ ] Live YOLO weights absent → §5 prints skip msg
- [ ] Dataset folder absent → §5 prints skip msg
- [ ] `ultralytics` not installed → §5 catches `ImportError`
- [ ] Infinite payback (subscription > savings) → "No payback at this tier"
- [ ] Sensitivity rank flip in §8 → warning markdown printed
- [ ] §6b: nursing-home baseline 27% vs hospital 8% — both render, both cited

---

## Validation Commands

### CSV integrity
```bash
python -c "import pandas as pd, glob; [pd.read_csv(f) for f in glob.glob('ml/notebooks/data/*.csv')]; print('csvs ok')"
```
EXPECT: `csvs ok`

### Notebook executes top-to-bottom
```bash
cd ml/notebooks && jupyter nbconvert --to notebook --execute benchmark_market_comparison.ipynb --output _exec_check.ipynb && rm _exec_check.ipynb
```
EXPECT: No exceptions. Live YOLO cell skips cleanly if weights absent.

### Makefile target
```bash
make -n benchmark
```
EXPECT: `cd ml/notebooks && jupyter lab benchmark_market_comparison.ipynb`

### README cross-link
```bash
grep -q "ml/notebooks/benchmark_market_comparison.ipynb" README.md && echo "linked"
```
EXPECT: `linked`

### .gitignore correctness
```bash
git check-ignore -v ml/notebooks/.ipynb_checkpoints/x
```
EXPECT: hit on the new rule

### Manual Validation
- [ ] Open notebook in JupyterLab; every cell renders without traceback
- [ ] PharmGuard appears in every chart, distinctly coloured
- [ ] Every chart has a source citation in markdown immediately below
- [ ] §6a renders both RN and CNA wage scenarios
- [ ] §6b renders error-rate baseline as a band (hospital_ltc + nursing_home) and includes the "*projected*" disclaimer
- [ ] §8 prints rank under both seeded weights and equal weights

---

## Acceptance Criteria
- [ ] Notebook at `ml/notebooks/benchmark_market_comparison.ipynb` executes top-to-bottom under `jupyter nbconvert --execute`
- [ ] All eight CSVs exist under `ml/notebooks/data/` with `source_url` populated on every row
- [ ] §6a (workforce) renders $/patient/month, FTE-hrs/month, and payback chart for RN + CNA
- [ ] §6b (outcomes) renders error-rate, adherence-rate, and avoided-harm-events with hospital + nursing-home baseline bands and a "*projected*" disclaimer
- [ ] §5 (CV) gracefully degrades when weights / dataset / `ultralytics` absent
- [ ] `make benchmark` launches JupyterLab on the notebook
- [ ] README link present; standards prose retained
- [ ] No PHI, no proprietary data, no hardcoded numbers — everything traces to a CSV row with a URL

## Completion Checklist
- [ ] Code follows `CSV_LOAD`, `CHART_STYLE`, `GRACEFUL_DEGRADE`, `WORKFORCE_MATH`, `OUTCOMES_MATH`
- [ ] Citations live in CSVs (not in code), surfaced in chart captions
- [ ] Workforce + outcomes numbers tied to published sources
- [ ] Notebook openable without GPU / `ultralytics`
- [ ] No widgets, no nbconvert pipeline, no CI
- [ ] `.ipynb_checkpoints/` added to `.gitignore`
- [ ] No edits to backend or frontend code

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Wage / time-study numbers are US-centric; project targets SG/MY market | Medium | Medium | CSV-driven — swap to MOH SG wage tables in `workforce.csv` without touching code |
| §6a `automation_factor` (0.5 vs 0.9) is team estimate, not measured | High | High | Surface as editable CSV column; add sensitivity sweep cell (factor 0.3→1.0) |
| §6b outcomes are *projected* from competitor studies, not measured on PharmGuard | Certain | High | Explicit disclaimer markdown cell; CSV-editable; band-format baseline so range is honest |
| Live YOLO eval reports detection-rate, not classification accuracy (no labels in `Medicine_Images/`) | Certain | Low | Document limitation in §5 markdown; published baseline is authoritative |
| Notebook bit-rot when CSVs evolve | Medium | Low | `nbconvert --execute` validation command exists; can be wired to CI later |
| Sources disagree on market size / pricing / error rate | Certain | Low | Use bands, not points; cite every row |
| Reader treats projected outcomes as measured | High | High | Disclaimer markdown above §6b chart AND `*projected*` annotation on the chart itself |

## Notes
- §6a (workforce $) and §6b (clinical outcomes) are the **new differentiators** over the README table. Treat them as the primary commercial + clinical story.
- Keep the notebook short (8 sections, ~28 cells). Anything longer becomes unreviewable. A reader skimming only §6a + §6b + §8 should still get the thesis.
- If the user later wants HTML export for stakeholders, add `jupyter nbconvert --to html` — only when asked. Out of scope here.
