# Implementation Report: Replace ILMU LLM with AWS Bedrock (Claude 3.5 Sonnet)

## Summary
Migrated the clinician-assistant LLM backend from the ILMU OpenAI-compatible API to AWS Bedrock's Converse API (Claude 3.5 Sonnet), called in-process via `boto3` `bedrock-runtime`. A new `services/bedrock_client.py` wraps the Converse call (mirroring the lazy-`boto3` pattern in `services/face_verify.py`). All three LLM call sites — the chat tool-loop and brief in `services/agent.py`, and the JSON soft pass in `services/flag_detector.py` — now use Converse message/tool/result blocks. ILMU config and the `openai` runtime dependency were removed. `gemini_fallback.py` (vision pill-ID) was left untouched per scope.

## Assessment vs Reality

| Metric | Predicted (Plan) | Actual |
|---|---|---|
| Complexity | Medium | Medium |
| Confidence | 8/10 | Held — single-pass, no rework |
| Files Changed | 8 (1 new, 7 edit) | 8 (1 new, 7 edit) |

## Tasks Completed

| # | Task | Status | Notes |
|---|---|---|---|
| 1 | Add Bedrock config keys | Complete | `bedrock_model_id/max_tokens/temperature`; reused existing `aws_*`; fixed ILMU comment |
| 2 | Create `services/bedrock_client.py` | Complete | Lazy client + `converse()` + `extract_text()` helper |
| 3 | `build_bedrock_tools()` in agent_tools | Complete | Reuses `_normalise_schema`; emits `toolSpec.inputSchema.json` |
| 4 | Rewrite chat loop + brief (agent.py) | Complete | Converse blocks; echo assistant turn; toolResult user msg |
| 5 | Migrate flag-detector soft pass | Complete | Gate flipped `ilmu_api_key`→`bedrock_model_id`; kept `detected_by="gemini"` |
| 6 | Dependencies | Complete | `boto3>=1.34.131`; removed unused `openai` |
| 7 | `.env.example` | Complete | Bedrock section; fixed `AGENT_FLAG_LLM_ENABLED` (was `_GEMINI_ENABLED`); dropped dead `AGENT_MODEL_NAME` |
| 8 | Comment fix (api/agent.py:62) | Complete | `GEMINI_API_KEY` → `BEDROCK_MODEL_ID` |

## Validation Results

| Level | Status | Notes |
|---|---|---|
| Static Analysis | Pass | All touched modules import; `py_compile` clean; zero `ilmu`/`openai` residue (1 intentional historical note in `bedrock_client.py:6`) |
| Unit Tests | Pass (manual) | No harness in repo; logic micro-tests for `_messages_to_bedrock`, `extract_text`, all 6 toolSpecs |
| Build | N/A | No build step for the Python backend |
| Integration | N/A — deferred | Live Converse needs `boto3` installed in venv + valid AWS creds + Bedrock model access. `boto3` not in the dev venv; aws-api MCP creds returned `InvalidClientTokenId` |
| Edge Cases | Pass | Leading-assistant drop, toolUse-ignoring text extract verified |

## Files Changed

| File | Action | Lines |
|---|---|---|
| `backend/services/bedrock_client.py` | CREATED | +92 |
| `backend/services/agent.py` | UPDATED | ~ +49 / -90 |
| `backend/services/flag_detector.py` | UPDATED | ~ +12 / -16 |
| `backend/services/agent_tools.py` | UPDATED | +20 / -12 (added `build_bedrock_tools`, removed dead `build_openai_tools`) |
| `backend/config.py` | UPDATED | +11 / -5 |
| `backend/requirements.txt` | UPDATED | +4 / -4 |
| `backend/.env.example` | UPDATED | +15 / -9 |
| `backend/api/agent.py` | UPDATED | +1 / -1 |

## Deviations from Plan
- **Removed `build_openai_tools` instead of keeping it.** The plan listed keeping it as optional. After Task 4 it had zero callers and still named the old provider ("OpenAI/ILMU"), so it was deleted as dead code — leaves the tool layer with a single Bedrock serializer.
- **`openai` removal executed (not left optional).** Confirmed no remaining `import openai` in `backend/**/*.py` before removing the pin.

## Issues Encountered
- **`boto3` absent from the dev venv** despite being in `requirements.txt`. Because the new client lazy-imports `boto3`, module-import smoke still passes; live Converse calls require `pip install -r requirements.txt` in the venv (and on the Pi). Captured as a Next Step.
- **aws-api MCP creds invalid** (`InvalidClientTokenId`) — could not live-verify the APAC inference-profile id or run a real `converse`. The model id is config-driven (`BEDROCK_MODEL_ID`), so any correction is a one-line `.env` change, not a code edit.

## Tests Written

| Test File | Tests | Coverage |
|---|---|---|
| (none persisted — no test harness in repo) | 3 inline logic checks | `_messages_to_bedrock` ordering, `extract_text` block filtering, `build_bedrock_tools` shape |

## Next Steps
- [ ] `pip install -r backend/requirements.txt` in the venv (and reinstall on the Pi) to pull `boto3>=1.34.131`.
- [ ] With valid AWS creds + Bedrock model access granted, run the build-time smoke:
      `aws bedrock list-inference-profiles --region ap-southeast-1` then a test `converse`; adjust `BEDROCK_MODEL_ID` if the profile id differs.
- [ ] Live endpoint smoke: `POST /api/agent/brief` and `/api/agent/chat` with `X-Device-API-Key`.
- [ ] Code review via `/code-review`.
- [ ] Create PR via `/prp-pr`.
