# PharmGuard ML

Training-side code and datasets. None of this runs on the Raspberry Pi — it is intended for a dev workstation with a GPU. The Pi consumes only the exported weights under `edge_pi/models/`.

## Layout

- `pill_detector/` — YOLO pill detector. Training scripts, run artifacts, and the `Medicine_Images/` source set.
- `spotter/` — Hand/pill spotter model (`spotter_model.pt`) and `live_detect.py` for webcam evaluation.
- `swallow/` — Mediapipe-based swallow detection prototype (`main5.py`).
- `datasets/pills/` — Raw labelled training data for the pill detector. Gitignored.

## Models

Retraining entry points:

```
python ml/pill_detector/yolo_detect.py
python ml/spotter/live_detect.py
python ml/swallow/main5.py
```

Each script documents its own dataset paths and hyperparameters. Outputs land in the corresponding subdirectory (e.g. `pill_detector/train/`), which is gitignored.

## Datasets

`datasets/pills/` is large (~1.5GB) and gitignored. To rebuild it, obtain the original Kaggle pill image dataset and unpack it into `ml/datasets/pills/` matching the directory layout expected by `pill_detector/yolo_detect.py`. Do not commit raw images.

## Promoting weights to Pi

After a successful training run, copy the exported `.pt` into `edge_pi/models/` under the runtime-expected filename:

```
cp ml/pill_detector/my_model.pt edge_pi/models/pill_detector.pt
cp ml/spotter/spotter_model.pt  edge_pi/models/spotter.pt
```

These copies were already done during the repo reorg, so `edge_pi/models/pill_detector.pt` and `edge_pi/models/spotter.pt` are the current production weights. Re-run the copy whenever you want to promote a new training run.
