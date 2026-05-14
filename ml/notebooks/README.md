# Benchmark Notebook

`benchmark_market_comparison.ipynb` benchmarks PharmGuard against the smart pill dispenser market (Hero Health, MedMinder, Livi, Pillo) across feature coverage, 3-yr TCO, market trajectory, CV accuracy, workforce-cost savings, projected clinical outcomes (error rate + adherence), standards conformance, and a weighted scorecard.

> No PHI, no proprietary data. Every CSV row carries a `source_url` citation.

## Run

```bash
pip install -r ml/notebooks/requirements.txt
make benchmark        # from repo root — opens JupyterLab on the notebook
```

Or open the `.ipynb` directly in any Jupyter / VS Code Notebook client.

To execute headless and validate it still runs end-to-end:

```bash
python3 -m nbconvert --to notebook --execute \
  ml/notebooks/benchmark_market_comparison.ipynb \
  --output _exec_check.ipynb && rm ml/notebooks/_exec_check.ipynb
```

## Data inputs (`data/*.csv`)

| File | Columns | Drives section |
|------|---------|----------------|
| `competitors.csv` | `product, face_recog, pill_cv, intake_confirm, offline, self_hostable, capacity_meds, source_url` | §2 |
| `pricing.csv` | `product, upfront_usd, monthly_usd, source_url` | §3, §6a payback |
| `market_size.csv` | `year, low_bn_usd, high_bn_usd, source_url` | §4 |
| `cv_benchmarks.csv` | `system, dataset, precision, recall, map, source_url` | §5 |
| `workforce.csv` | `product, role, hourly_wage_usd, minutes_per_event, events_per_day, automation_factor, source_url` | §6a |
| `outcomes.csv` | `product, baseline_setting, baseline_error_rate, product_error_rate, baseline_adherence, product_adherence, harm_fraction, events_per_day, source_url` | §6b |
| `fleet_scenario.csv` | `hospital_size_label, total_beds, num_corners, beds_per_corner, dispensers_per_corner, total_dispensers, hardware_unit_cost, subscription_monthly, source_url` | §6c |
| `staffing_baseline.csv` | `hospital_size_label, total_beds, med_admin_minutes_per_patient_per_day, nurse_hourly_wage, nurse_burden_multiplier, hospital_pharmacist_annual_salary, pharmacists_per_100_beds, events_per_day, source_url` | §6c |
| `shortage.csv` | `region, role, baseline_deficit, projection_year, projected_deficit, source_url` | §6c |
| `standards.csv` | `product, standard, status, source_url` (status ∈ `designed-toward / partial / out-of-scope / unknown`) | §7 |
| `scorecard_weights.csv` | `criterion, weight, <product...>, source_url` | §8 |

## Honesty rules

- **§5 live CV eval** reports detection-rate + mean-confidence only — `Medicine_Images/` filenames carry no class labels. The published baseline row is the authoritative precision/recall.
- **§6b outcomes** are *projected* from competitor adherence RCTs plus PharmGuard's intake-confirm gate. They are not measured outcomes on PharmGuard itself.
- **§6a automation_factor** is a team estimate (0.5 for dispense-only competitors, 0.9 for PharmGuard with intake confirmation). CSV-editable — sweep it to sensitivity-test.

## Adding a new competitor

1. Append a row to every relevant CSV (only `product` and `source_url` are mandatory across all of them).
2. Re-run the notebook.

No code edit required.
