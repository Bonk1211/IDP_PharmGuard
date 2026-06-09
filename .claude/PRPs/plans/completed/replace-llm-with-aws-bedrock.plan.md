# Plan: Replace ILMU LLM with AWS Bedrock (Claude 3.5 Sonnet)

## Summary
Migrate the clinician-assistant LLM backend from the ILMU OpenAI-compatible API to AWS Bedrock's **Converse API** running **Claude 3.5 Sonnet**, called in-process via `boto3` (`bedrock-runtime`). Three call sites change: the tool-calling chat loop and single-shot brief in `services/agent.py`, and the JSON-array soft pass in `services/flag_detector.py`. The `aws-api` MCP is a **build-time-only** discovery/verification tool — it is never wired into runtime.

## User Story
As a **nurse/pharmacist using the PharmGuard dashboard**, I want the clinician assistant (chat, shift brief, anomaly flags) to run on **AWS Bedrock Claude 3.5 Sonnet** instead of ILMU, so that the assistant runs on the same AWS account that already powers face-verify/label-detection, with no third-party LLM dependency and stronger tool-use reasoning.

## Problem → Solution
**Current:** `services/agent.py` and `services/flag_detector.py` instantiate an `openai.OpenAI` client pointed at `settings.ilmu_base_url` and call `client.chat.completions.create(...)` with OpenAI-shaped `tools=`/`tool_choice=`.
**Desired:** A new `services/bedrock_client.py` lazy-inits a `boto3` `bedrock-runtime` client (mirroring `services/face_verify.py`) and exposes a `converse(...)` helper. All three call sites use Bedrock's Converse message/tool/result block shapes. ILMU config + the `openai` runtime dependency drop out.

## Metadata
- **Complexity**: Medium
- **Source PRD**: N/A (free-form request)
- **PRD Phase**: N/A
- **Estimated Files**: 8 (1 new, 7 edits)

---

## UX Design

### Before / After
Internal change — **no user-facing UX transformation**. The dashboard chat box, brief panel, and flag list behave identically. The only observable difference is the `metadata.model` string returned by `/api/agent/*` (was `"nemo-super"`, becomes the Bedrock model/profile id) and slightly different LLM phrasing.

### Interaction Changes
| Touchpoint | Before | After | Notes |
|---|---|---|---|
| `POST /api/agent/chat` | ILMU tool loop | Bedrock Converse tool loop | Same request/response JSON shape |
| `POST /api/agent/brief` | ILMU single-shot | Bedrock single-shot | `metadata.model` value changes |
| `POST /api/agent/flags/detect` | ILMU JSON pass | Bedrock JSON pass | Response still carries `gemini_used` |
| Frontend `agent.ts` | reads `gemini_used` | unchanged | **Must keep `gemini_used` key** (frontend/src/lib/agent.ts:220) |

---

## Mandatory Reading

| Priority | File | Lines | Why |
|---|---|---|---|
| P0 | `backend/services/agent.py` | 83-343 | The two call sites to rewrite: lazy client + chat tool loop + `generate_brief` |
| P0 | `backend/services/face_verify.py` | 30-47 | **The lazy-`boto3`-client pattern to mirror exactly** for the new Bedrock client |
| P0 | `backend/services/agent_tools.py` | 344-390 | `build_openai_tools` + `_normalise_schema` — clone into `build_bedrock_tools` |
| P0 | `backend/config.py` | 68-104 | ILMU + AWS settings block to edit (AWS creds already exist) |
| P1 | `backend/services/flag_detector.py` | 59-81, 110-118, 347-417 | Third call site (inline OpenAI client) + the LLM gate at 113 |
| P1 | `backend/api/agent.py` | 44-118 | Error→503 contract; stale comment at line 62 |
| P1 | `backend/scheduler/brief_scheduler.py` | 64-107 | Calls `generate_brief` + `detect_and_persist_flags`; reads `metadata.latency_ms` — no edit, just don't break the keys |
| P2 | `backend/.env.example` | 32-90 | Stale (still Gemini, pre-ILMU); rewrite assistant section to Bedrock |
| P2 | `frontend/src/lib/agent.ts` | 220 | Confirms `gemini_used` is the only field consumed from flag detection |

## External Documentation

| Topic | Source | Key Takeaway |
|---|---|---|
| Bedrock Converse API | AWS docs: `bedrock-runtime` `Converse` | `messages` are `[{role, content:[block,...]}]`; system prompt is a **separate** `system=[{"text":...}]` param; tools go in `toolConfig`, not `tools=` |
| Converse tool use | AWS docs: Converse tool use | Tool spec = `{"toolSpec":{"name","description","inputSchema":{"json":<JSONSchema>}}}`; model returns `content` blocks with `{"toolUse":{"toolUseId","name","input"}}` and `stopReason=="tool_use"`; you reply with a **user** msg containing `{"toolResult":{"toolUseId","content":[{"json":...}]}}` |
| APAC on-demand access | AWS docs: cross-region inference | In `ap-southeast-1`, Claude 3.5 Sonnet on-demand is served via a **cross-region inference profile** (`apac.anthropic.claude-3-5-sonnet-...`). The bare foundation-model id throws `ValidationException: on-demand throughput isn't supported` |
| boto3 Converse availability | boto3 changelog | `converse` landed in `boto3` ~1.34.131 (May 2024) — bump the floor |

> **Build-time verification (MCP, dev only):** the `aws-api` MCP was used during planning but returned `InvalidClientTokenId` (no valid creds in the MCP sandbox). Before/while implementing, re-run with working creds to confirm the exact profile id:
> ```
> aws bedrock list-inference-profiles --region ap-southeast-1
> aws bedrock list-foundation-models --region ap-southeast-1 --by-provider anthropic
> aws bedrock-runtime converse --region ap-southeast-1 --model-id apac.anthropic.claude-3-5-sonnet-20241022-v2:0 --messages '[{"role":"user","content":[{"text":"ping"}]}]' --inference-config '{"maxTokens":16}'
> ```
> If `list-*` shows a different/newer profile id, set `BEDROCK_MODEL_ID` accordingly — the code reads it from config, so no code edit is needed.

---

## Patterns to Mirror

### LAZY_BOTO3_CLIENT
```python
# SOURCE: backend/services/face_verify.py:30-47
_client = None  # boto3 rekognition client cache

def _get_client():
    """Lazy-init boto3 rekognition client. ONE per process."""
    global _client
    if _client is not None:
        return _client
    import boto3  # lazy import — avoids ~300ms cost when feature unused
    _client = boto3.client(
        "rekognition",
        region_name=settings.aws_region,
        # Empty strings → None so boto3 falls back to env / shared creds.
        aws_access_key_id=settings.aws_access_key_id or None,
        aws_secret_access_key=settings.aws_secret_access_key or None,
    )
    return _client
```

### TOOL_SCHEMA_BUILDER
```python
# SOURCE: backend/services/agent_tools.py:344-367
def build_openai_tools() -> list[dict]:
    decls: list[dict] = []
    for t in TOOLS:
        schema = t.args_schema.model_json_schema()
        schema = _normalise_schema(schema)          # collapses anyOf+null, drops title
        decls.append({
            "type": "function",
            "function": {"name": t.name, "description": t.description, "parameters": schema},
        })
    return decls
```

### ERROR_HANDLING (503 contract)
```python
# SOURCE: backend/api/agent.py:57-63
    try:
        result = await asyncio.wait_for(chat(safe_messages), timeout=60.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="agent took too long (>60 s)")
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
```
→ Keep the `RuntimeError → 503` path: `bedrock_client._get_client()` raises `RuntimeError` when `BEDROCK_MODEL_ID` is unset, exactly like the old `ilmu_api_key` gate.

### LOGGING_PATTERN
```python
# SOURCE: backend/services/agent.py:102-106
        log.info("agent: ILMU client ready (base=%s model=%s)",
                 settings.ilmu_base_url, settings.ilmu_model)
# SOURCE: backend/services/flag_detector.py:117-118
        except Exception:
            log.exception("flag_detector: LLM pass failed, continuing without")
```
→ `log.info("agent: Bedrock client ready (region=%s model=%s)", ...)`; keep `log.exception(...)` on call failure.

### CONFIG_PATTERN
```python
# SOURCE: backend/config.py:68-74  (block to REPLACE)
    # ── Clinician assistant (read-only ILMU agent) ────────────────────────
    ilmu_api_key: str = ""
    ilmu_base_url: str = "https://api.ilmu.ai/v1"
    ilmu_model: str = "nemo-super"
# SOURCE: backend/config.py:87-89  (AWS creds — ALREADY PRESENT, reuse, do not duplicate)
    aws_region: str = "ap-southeast-1"
    aws_access_key_id: str = ""
    aws_secret_access_key: str = ""
```

### TEST_STRUCTURE
No test suite exists (`pytest`/`vitest` not configured — see CLAUDE.md). Validation is manual + import/lint smoke (see Validation Commands). Do **not** claim "tests pass".

---

## Files to Change

| File | Action | Justification |
|---|---|---|
| `backend/services/bedrock_client.py` | CREATE | Lazy `bedrock-runtime` client + `converse(...)` helper (mirrors face_verify) |
| `backend/services/agent.py` | UPDATE | Rewrite chat tool loop + `generate_brief` to Converse blocks; drop OpenAI client |
| `backend/services/agent_tools.py` | UPDATE | Add `build_bedrock_tools()` (reuse `_normalise_schema`) |
| `backend/services/flag_detector.py` | UPDATE | `_detect_via_llm` → `converse`; flip gate `ilmu_api_key`→`bedrock_model_id` |
| `backend/config.py` | UPDATE | Replace `ilmu_*` with `bedrock_model_id/max_tokens/temperature`; reuse existing `aws_*` |
| `backend/requirements.txt` | UPDATE | Bump `boto3>=1.34.131`; drop now-unused `openai` (optional) |
| `backend/.env.example` | UPDATE | Rewrite assistant section to Bedrock; fix `AGENT_FLAG_*` key names |
| `backend/api/agent.py` | UPDATE | Comment-only: stale `GEMINI_API_KEY` reference at line 62 |

## NOT Building
- **`services/gemini_fallback.py`** — out of scope. Vision pill-ID stays on Gemini (per scope decision); `google-generativeai` dependency stays.
- **Streaming responses** — keep the existing buffered `wait_for(..., 60s)` request/response shape. No `ConverseStream`.
- **Frontend changes** — `gemini_used` key is preserved server-side; `agent.ts` is untouched.
- **DB schema / `agent_flags.detected_by` enum** — keep emitting `detected_by="gemini"` for the LLM soft pass (DB enum + frontend compat). No migration.
- **Removing `metadata.gemini_used` / renaming to `bedrock_used`** — would break frontend; explicitly NOT doing it.
- **IAM/role provisioning, Bedrock model-access grant** — operator/console task, captured as a Risk, not code.

---

## Step-by-Step Tasks

### Task 1: Add Bedrock config keys
- **ACTION**: In `backend/config.py`, replace the ILMU block (lines 68-74) with Bedrock keys. Leave the existing `aws_*` keys (87-89) as-is.
- **IMPLEMENT**:
  ```python
  # ── Clinician assistant (read-only AWS Bedrock agent) ─────────────────
  # Claude via Bedrock Converse API. APAC on-demand requires a cross-region
  # inference PROFILE id (apac.*), NOT the bare foundation-model id — the
  # bare id raises ValidationException "on-demand throughput isn't supported".
  # Verify for this account/region:
  #   aws bedrock list-inference-profiles --region ap-southeast-1
  bedrock_model_id: str = "apac.anthropic.claude-3-5-sonnet-20241022-v2:0"
  bedrock_max_tokens: int = 2048
  bedrock_temperature: float = 0.2
  ```
  Also fix the comment at lines 79-80: `ILMU_API_KEY` → `the LLM`.
- **MIRROR**: CONFIG_PATTERN.
- **IMPORTS**: none new.
- **GOTCHA**: Reuse existing `aws_region`/`aws_access_key_id`/`aws_secret_access_key` (lines 87-89) — do **not** add duplicates. `bedrock_model_id` has a non-empty default so the LLM is "on" by default (matches prior intent where ILMU had a key).
- **VALIDATE**: `cd backend && python -c "from config import settings; print(settings.bedrock_model_id, settings.bedrock_max_tokens)"`

### Task 2: Create `services/bedrock_client.py`
- **ACTION**: New module: lazy `bedrock-runtime` client + `converse(...)` wrapper.
- **IMPLEMENT**:
  ```python
  """Lazy AWS Bedrock (bedrock-runtime) Converse client for the clinician
  assistant. Mirrors services/face_verify.py: one boto3 client per process,
  lazy-imported so import-time stays side-effect-free.

  Raises RuntimeError when BEDROCK_MODEL_ID is unset so api/agent.py maps it
  to a 503 (same contract the old ILMU key-gate had).
  """
  from __future__ import annotations
  import logging
  from config import settings

  log = logging.getLogger(__name__)
  _client = None  # boto3 bedrock-runtime client cache

  def _get_client():
      global _client
      if _client is not None:
          return _client
      if not settings.bedrock_model_id:
          raise RuntimeError(
              "BEDROCK_MODEL_ID not set — agent endpoints unavailable. "
              "Set it in backend/.env to enable the clinician assistant."
          )
      import boto3  # lazy import
      _client = boto3.client(
          "bedrock-runtime",
          region_name=settings.aws_region,
          aws_access_key_id=settings.aws_access_key_id or None,
          aws_secret_access_key=settings.aws_secret_access_key or None,
      )
      log.info("agent: Bedrock client ready (region=%s model=%s)",
               settings.aws_region, settings.bedrock_model_id)
      return _client

  def converse(*, system: str | None, messages: list[dict],
               tools: list[dict] | None = None,
               max_tokens: int | None = None,
               temperature: float | None = None) -> dict:
      """Thin Converse wrapper. `messages` are Bedrock content-block messages.
      Returns the raw Converse response dict (caller reads output.message)."""
      kwargs: dict = {
          "modelId": settings.bedrock_model_id,
          "messages": messages,
          "inferenceConfig": {
              "maxTokens": max_tokens or settings.bedrock_max_tokens,
              "temperature": settings.bedrock_temperature if temperature is None else temperature,
          },
      }
      if system:
          kwargs["system"] = [{"text": system}]
      if tools:
          kwargs["toolConfig"] = {"tools": tools}
      return _get_client().converse(**kwargs)

  def extract_text(resp: dict) -> str:
      """Join all text blocks from a Converse response's output message."""
      blocks = resp.get("output", {}).get("message", {}).get("content", [])
      return "".join(b.get("text", "") for b in blocks if "text" in b)
  ```
- **MIRROR**: LAZY_BOTO3_CLIENT, LOGGING_PATTERN.
- **IMPORTS**: `boto3` (lazy, already a dep), `config.settings`.
- **GOTCHA**: `system` is a top-level Converse param, NOT a message. `temperature` of `0` is valid → guard with `is None`, not truthiness.
- **VALIDATE**: `cd backend && python -c "import services.bedrock_client as b; print(b.converse, b.extract_text)"` (no network).

### Task 3: Add `build_bedrock_tools()` to `agent_tools.py`
- **ACTION**: Add a Bedrock tool-spec builder next to `build_openai_tools`; reuse `_normalise_schema`.
- **IMPLEMENT**:
  ```python
  def build_bedrock_tools() -> list[dict]:
      """Convert TOOLS into Bedrock Converse toolConfig.tools.

      Format:
          [{"toolSpec": {"name": ..., "description": ...,
                         "inputSchema": {"json": <JSON schema>}}}, ...]
      Pass as toolConfig={"tools": build_bedrock_tools()}.
      """
      decls: list[dict] = []
      for t in TOOLS:
          schema = _normalise_schema(t.args_schema.model_json_schema())
          decls.append({
              "toolSpec": {
                  "name": t.name,
                  "description": t.description,
                  "inputSchema": {"json": schema},
              }
          })
      return decls
  ```
  Keep `build_openai_tools` (harmless; or delete if you want zero dead code — it has no other callers after Task 4).
- **MIRROR**: TOOL_SCHEMA_BUILDER.
- **IMPORTS**: none new (`_normalise_schema`, `TOOLS` already in module).
- **GOTCHA**: Bedrock Converse wants a plain JSON Schema under `inputSchema.json`. `_normalise_schema` already collapses Pydantic `anyOf:[T,null]` and strips `title` — Bedrock tolerates standard JSON Schema, so no extra stripping needed (same as OpenAI path).
- **VALIDATE**: `cd backend && python -c "from services.agent_tools import build_bedrock_tools as f; import json; print(json.dumps(f()[0], indent=2)[:400])"` — confirm `toolSpec.inputSchema.json` present.

### Task 4: Rewrite the chat tool loop + brief in `services/agent.py`
- **ACTION**: Replace the OpenAI client + loop. Specifically: delete `_get_client` (lines 85-107); replace `_messages_to_openai` (112-121) with `_messages_to_bedrock`; rewrite `chat` body (148-250) and the `generate_brief` LLM call (313-329). Update module docstring + system-prompt comments away from "ILMU".
- **IMPLEMENT** (`_messages_to_bedrock`):
  ```python
  def _messages_to_bedrock(messages: list[dict]) -> list[dict]:
      """{role,text} -> Bedrock content-block messages. Drops system role.
      Bedrock requires the FIRST message role == 'user'."""
      out: list[dict] = []
      for m in messages:
          role = m.get("role")
          if role in ("user", "assistant"):
              out.append({"role": role, "content": [{"text": m.get("text", "")}]})
      while out and out[0]["role"] != "user":
          out.pop(0)
      return out
  ```
  **`chat` loop** (replace the OpenAI `create`/`tool_calls` plumbing):
  ```python
  t0 = time.time()
  tools = agent_tools.build_bedrock_tools()
  messages = _messages_to_bedrock(messages)
  tool_calls_out: list[dict] = []
  text_reply = ""
  truncated = False

  for hop in range(_MAX_TOOL_HOPS):
      try:
          resp = await asyncio.to_thread(
              bedrock_client.converse,
              system=_SYSTEM_PROMPT_CHAT,
              messages=messages,
              tools=tools,
          )
      except Exception:
          log.exception("agent.chat: Bedrock call failed at hop %d", hop)
          return {
              "text": ("I couldn't reach the assistant just now. "
                       "Try again in a moment, or check the backend logs."),
              "tool_calls": tool_calls_out,
              "metadata": {"hops": hop,
                           "latency_ms": int((time.time() - t0) * 1000),
                           "model": settings.bedrock_model_id,
                           "truncated": False, "error": True},
          }

      out_msg = resp["output"]["message"]
      messages.append(out_msg)  # echo assistant turn (incl. toolUse blocks) back
      blocks = out_msg.get("content", [])
      tool_uses = [b["toolUse"] for b in blocks if "toolUse" in b]

      if resp.get("stopReason") == "tool_use" and tool_uses:
          tool_result_blocks: list[dict] = []
          for tu in tool_uses:
              name = tu["name"]
              raw_args = tu.get("input") or {}
              try:
                  result = await asyncio.to_thread(agent_tools.dispatch, name, raw_args)
              except Exception as exc:
                  log.warning("agent.chat: tool %s failed: %s", name, exc)
                  result = {"error": str(exc)}
              tool_calls_out.append({
                  "name": name, "args": raw_args,
                  "result_summary": _summarise_tool_result(name, result),
              })
              tool_result_blocks.append({
                  "toolResult": {
                      "toolUseId": tu["toolUseId"],
                      "content": [{"json": _coerce_to_json_safe(result)}],
                  }
              })
          messages.append({"role": "user", "content": tool_result_blocks})
          continue

      text_reply = "".join(b.get("text", "") for b in blocks if "text" in b).strip()
      break
  else:
      truncated = True
      text_reply = ("I needed more lookups than I'm allowed in one turn. "
                    "Try narrowing the question (e.g., a specific patient or date).")

  return {
      "text": text_reply or "(no response)",
      "tool_calls": tool_calls_out,
      "metadata": {"hops": len(tool_calls_out) + (0 if truncated else 1),
                   "latency_ms": int((time.time() - t0) * 1000),
                   "model": settings.bedrock_model_id, "truncated": truncated},
  }
  ```
  **`generate_brief`** (replace lines 313-329; keep all the pre-fetch + payload code above it):
  ```python
  try:
      resp = await asyncio.to_thread(
          bedrock_client.converse,
          system=_SYSTEM_PROMPT_BRIEF,
          messages=[{"role": "user", "content": [{"text": user_prompt}]}],
      )
      content_md = bedrock_client.extract_text(resp).strip()
  except Exception:
      log.exception("agent.generate_brief: Bedrock call failed")
      content_md = ("## Brief unavailable\n\n"
                    "LLM call failed. Check backend logs and BEDROCK_MODEL_ID.")
  ```
  And change the brief `metadata.model` (line ~335) `settings.ilmu_model` → `settings.bedrock_model_id`.
- **MIRROR**: External Documentation (Converse tool use); ERROR_HANDLING.
- **IMPORTS**: add `from services import bedrock_client`; **remove** the `from openai import OpenAI` (it was inside `_get_client`, deleted). Keep `agent_tools`, `asyncio`, `json`, `time`.
- **GOTCHA**:
  - `_coerce_to_json_safe` (existing, lines 253-258) is reused for `toolResult.content[0].json` — Bedrock requires the tool result to be JSON-serializable.
  - Append the assistant `out_msg` **verbatim** before the toolResult user msg, else Converse rejects an orphan `toolResult` (`toolUseId` must reference the immediately-preceding assistant `toolUse`).
  - Converse rejects an assistant message with empty `content`; echoing the model's own `out_msg` avoids constructing one by hand.
  - First message must be `user` — `_messages_to_bedrock` enforces it.
- **VALIDATE**: `cd backend && python -c "import services.agent"` (import smoke — no `openai` import remains, no NameError).

### Task 5: Migrate the flag-detector LLM soft pass
- **ACTION**: In `services/flag_detector.py`, (a) flip the gate at line 113, (b) replace the inline OpenAI client (lines 368-385) with a `converse` call. Update the module docstring + `_LLM_PROMPT` comments off "ILMU".
- **IMPLEMENT**:
  - Line 113: `if settings.ilmu_api_key and settings.agent_flag_llm_enabled:` → `if settings.bedrock_model_id and settings.agent_flag_llm_enabled:`
  - Replace lines 368-385:
    ```python
    from services import bedrock_client
    resp = await asyncio.to_thread(
        bedrock_client.converse,
        system=_LLM_PROMPT,
        messages=[{"role": "user", "content": [{"text": user_prompt}]}],
    )
    text = bedrock_client.extract_text(resp).strip()
    ```
- **MIRROR**: Task 2 `converse` + `extract_text`.
- **IMPORTS**: `from services import bedrock_client` (top of file or local, matching the existing local `from openai import OpenAI`); remove the OpenAI import line.
- **GOTCHA**: Keep `detected_by="gemini"` (line 415) and the `gemini_used` return key (line 140) — DB enum + `frontend/src/lib/agent.ts:220` depend on them. Do NOT rename. `_safe_parse_json_array` is unchanged (Claude may still wrap JSON in fences — the tolerant parser already handles it).
- **VALIDATE**: `cd backend && python -c "import services.flag_detector"` (import smoke).

### Task 6: Dependencies
- **ACTION**: In `backend/requirements.txt`, bump boto3 and drop the now-unused `openai`.
- **IMPLEMENT**: `boto3>=1.34.0` → `boto3>=1.34.131  # Converse API`. Delete `openai>=1.40.0` (line 32) — no remaining importers after Tasks 4-5. Keep `google-generativeai>=0.8.0` (still used by `gemini_fallback.py`).
- **MIRROR**: existing requirements comment style.
- **IMPORTS**: n/a.
- **GOTCHA**: `openai` removal is **optional** — leaving it pinned is harmless. If unsure, grep first: `grep -rn "import openai\|from openai" backend --include=*.py | grep -v .venv` must return nothing before deleting.
- **VALIDATE**: `cd backend && grep -n "boto3\|openai" requirements.txt`; then `grep -rn "from openai\|import openai" backend --include=*.py | grep -v .venv` → empty.

### Task 7: Update `.env.example`
- **ACTION**: Rewrite the stale "Clinician assistant (read-only Gemini agent)" section (lines 75-90) for Bedrock; note AWS creds are shared with the existing Rekognition block (lines 32-36).
- **IMPLEMENT**:
  ```
  # ─── Clinician assistant (read-only AWS Bedrock agent) ───
  # Uses the SAME AWS_REGION / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY as the
  # Rekognition block above (or an attached IAM role — leave keys empty for that).
  # PHI DISCLAIMER: enabling the assistant sends patient data (names, conditions,
  # adherence + alert rows) to AWS Bedrock. Unset BEDROCK_MODEL_ID to disable
  # /api/agent/* and the scheduled brief (they return 503 / silently skip).
  # APAC on-demand needs a cross-region inference PROFILE id (apac.*); verify with
  #   aws bedrock list-inference-profiles --region ap-southeast-1
  BEDROCK_MODEL_ID=apac.anthropic.claude-3-5-sonnet-20241022-v2:0
  BEDROCK_MAX_TOKENS=2048
  BEDROCK_TEMPERATURE=0.2
  # CSV of LOCAL hours (24h) for the shift-handover brief. Empty disables scheduler.
  AGENT_BRIEF_LOCAL_HOURS=7,19
  AGENT_FLAG_MISSED_STREAK_THRESHOLD=3
  AGENT_FLAG_LOW_CONFIDENCE_THRESHOLD=0.55
  # Set 0/false to skip the Bedrock soft-pattern pass.
  AGENT_FLAG_LLM_ENABLED=1
  ```
- **MIRROR**: `.env.example` comment style (lines 32-52).
- **GOTCHA**: The old example used `AGENT_FLAG_GEMINI_ENABLED` (line 90) and `AGENT_MODEL_NAME` (line 81) — both wrong vs `config.py` (`agent_flag_llm_enabled`; no `agent_model_name`). Use `AGENT_FLAG_LLM_ENABLED`. Leave unrelated keys (`FACE_MATCH_TOLERANCE`, etc.) alone — out of scope.
- **VALIDATE**: visual diff; `grep -n "BEDROCK_MODEL_ID\|AGENT_FLAG_LLM_ENABLED" backend/.env.example`.

### Task 8: Fix stale comment in `api/agent.py`
- **ACTION**: Line 62 comment `# _ensure_configured raises this when GEMINI_API_KEY is missing.` → `# bedrock_client._get_client raises this when BEDROCK_MODEL_ID is unset.`
- **IMPLEMENT**: comment text only; no logic change (the `except RuntimeError → 503` already does the right thing).
- **MIRROR**: ERROR_HANDLING.
- **GOTCHA**: Don’t touch the response keys at lines 113-116 (`gemini_used`, `by_kind`); note `new_count` there is already a latent mismatch (`flag_detector` returns `new_flags`) — pre-existing, **out of scope**, do not "fix" in this change.
- **VALIDATE**: `cd backend && python -c "import api.agent"`.

---

## Testing Strategy

### Unit Tests
No unit-test harness in repo. Below are the **manual checks** that stand in for unit tests.

| Check | Input | Expected | Edge? |
|---|---|---|---|
| Config loads | import `settings` | `bedrock_model_id` non-empty, no `ilmu_*` AttributeError elsewhere | — |
| Tool schema | `build_bedrock_tools()[0]` | has `toolSpec.inputSchema.json` | — |
| Chat happy path | one user msg via `POST /api/agent/chat` | 200, `metadata.model==BEDROCK_MODEL_ID`, tools fire | — |
| Brief | `POST /api/agent/brief?kind=on_demand` | 200, markdown body, persisted row | — |
| Flags | `POST /api/agent/flags/detect` | 200, `gemini_used` present | — |
| Not configured | unset `BEDROCK_MODEL_ID` | chat/brief → **503** (not 500) | empty config |
| Bad region/profile | wrong `BEDROCK_MODEL_ID` | chat → friendly error text + `metadata.error:true`; brief → "## Brief unavailable" | access fail |

### Edge Cases Checklist
- [ ] Empty `messages` → still 400 (unchanged in `api/agent.py:46`).
- [ ] Multi-hop tool loop hits `_MAX_TOOL_HOPS` → `truncated:true` text.
- [ ] Tool raises → `{"error": ...}` flows back as a `toolResult` block (loop continues).
- [ ] Model returns fenced JSON in flag pass → `_safe_parse_json_array` still parses.
- [ ] `BEDROCK_MODEL_ID` set but Bedrock model access NOT granted → `AccessDeniedException` caught → friendly degrade, not crash.
- [ ] APAC bare model id (no `apac.` prefix) → `ValidationException` surfaced as degrade (documents the inference-profile requirement).

---

## Validation Commands

### Static / import smoke
```bash
cd backend && source .venv/bin/activate
python -c "import config, services.bedrock_client, services.agent, services.flag_detector, api.agent; print('imports OK')"
grep -rn "from openai\|import openai\|settings.ilmu" backend --include=*.py | grep -v .venv   # EXPECT: empty
```
EXPECT: `imports OK`, no `openai`/`ilmu` references remain.

### Tool-spec shape
```bash
cd backend && python -c "from services.agent_tools import build_bedrock_tools as f; import json; t=f()[0]['toolSpec']; assert 'inputSchema' in t and 'json' in t['inputSchema']; print('toolSpec OK', t['name'])"
```
EXPECT: `toolSpec OK <first tool name>`.

### Bedrock connectivity (build-time, MCP or CLI, needs valid creds)
```bash
aws bedrock-runtime converse --region ap-southeast-1 \
  --model-id apac.anthropic.claude-3-5-sonnet-20241022-v2:0 \
  --messages '[{"role":"user","content":[{"text":"reply with the word ok"}]}]' \
  --inference-config '{"maxTokens":16}'
```
EXPECT: a JSON response with `output.message.content[0].text`. `AccessDeniedException` → grant model access in Bedrock console; `ValidationException` → wrong/blocked model id, re-run `list-inference-profiles`.

### Live endpoint smoke (backend running)
```bash
cd backend && uvicorn app.main:app --reload --port 8000   # or the project's main entrypoint per CLAUDE.md
# in another shell (replace KEY with DEVICE_API_KEY):
curl -s -XPOST 'localhost:8000/api/agent/brief?kind=on_demand' -H "X-Device-API-Key: $KEY" | head -c 400
curl -s -XPOST localhost:8000/api/agent/chat -H "X-Device-API-Key: $KEY" \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","text":"what needs my attention today?"}]}' | python -m json.tool
```
EXPECT: brief markdown; chat JSON with `metadata.model` == the Bedrock id and (likely) a `tool_calls` entry for `query_flags`/`today_summary`.

### Frontend lint (only if `.env.example` doc change matters)
```bash
cd frontend && npm run lint
```
EXPECT: no new errors (no frontend code changed).

### Database
No schema change. `agent_flags`/`agent_briefs` writes are unchanged.

### Manual Validation
- [ ] `make backend` boots without import error.
- [ ] Dashboard chat returns a Bedrock-authored reply.
- [ ] Brief panel renders; a new `agent_briefs` row exists.
- [ ] Flag detect runs; `gemini_used` true when access works, false on degrade.
- [ ] Unsetting `BEDROCK_MODEL_ID` yields 503 (not 500) from `/api/agent/chat`.

---

## Acceptance Criteria
- [ ] All 8 tasks completed.
- [ ] All import/smoke validation commands pass.
- [ ] No `openai`/`ilmu_*` references remain in `backend/**/*.py`.
- [ ] `metadata.model` reflects `BEDROCK_MODEL_ID` across chat + brief.
- [ ] `gemini_used` key still present in flag-detection responses.
- [ ] Missing/blocked Bedrock config degrades to 503/friendly text, never 500/crash.

## Completion Checklist
- [ ] New client mirrors `face_verify.py` lazy-boto3 pattern.
- [ ] Tool plumbing uses Converse blocks (system param, toolSpec, toolResult).
- [ ] Error handling keeps `RuntimeError → 503` contract.
- [ ] Logging matches `agent:`/`flag_detector:` prefixes.
- [ ] No DB/schema/frontend churn.
- [ ] `.env.example` accurate (Bedrock + correct `AGENT_FLAG_LLM_ENABLED`).
- [ ] Self-contained — no further codebase search needed to implement.

## Risks
| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Bedrock model access not granted on the AWS account | High | Assistant returns degrade text | Grant access in Bedrock console; verify with the `converse` CLI/MCP smoke before shipping |
| Wrong inference-profile id for `ap-southeast-1` | Med | `ValidationException` on every call | `BEDROCK_MODEL_ID` is config-driven; re-run `list-inference-profiles` and set it — no code edit |
| boto3 on the Pi < 1.34.131 lacks `converse` | Med | `AttributeError`/`UnknownOperation` | Pinned `boto3>=1.34.131`; `make pi-sync` + reinstall venv on Pi |
| Converse rejects message ordering (orphan toolResult / empty content) | Med | 4xx ValidationException mid-loop | Echo `out_msg` verbatim; enforce first-msg `user`; both baked into Task 4 |
| PHI sent to a new processor (AWS) | Low (already on AWS for Rekognition) | Compliance | Same disclaimer pattern as existing `.env.example`; operator opt-in via `BEDROCK_MODEL_ID` |
| MCP creds invalid during planning (couldn't live-verify ids) | Realized | Model id may need adjustment | Verification step + config-driven id make this a 1-line `.env` fix, not a code change |

## Notes
- The `aws-api` MCP returned `InvalidClientTokenId` during planning, so the exact APAC inference-profile id was **not** live-verified. The chosen default (`apac.anthropic.claude-3-5-sonnet-20241022-v2:0`) is the standard APAC cross-region profile for Claude 3.5 Sonnet v2; confirm with `aws bedrock list-inference-profiles --region ap-southeast-1` and override `BEDROCK_MODEL_ID` if different.
- `boto3` is already a dependency (Rekognition), and AWS creds already live in `config.py` — this migration adds **no new SDK** and **no new credential surface**, only a new client + the Converse plumbing.
- `services/agent_tools.py` stays the single source of tool definitions; only the serialization differs (`build_openai_tools` vs `build_bedrock_tools`), so adding a tool still touches one place.
