# Vision Transcription (geo-vision)

`geo-vision` transcribes figure images in exam questions into structured,
schema-validated text that `geo_solve` attaches to the problem. It is
**provider-agnostic** (any OpenAI-compatible vision endpoint) and designed to
**degrade explicitly** — a failed transcription is reported, never silently
faked.

## Data flow

```
geo_solve(qid)
  └─ geoVision.extract(qid)
       ├─ kernel.imageRefs(qid)         # resolve markdown image refs → disk paths
       ├─ resolveVisionModel()          # provider/model from config or auto-discovery
       │    └─ capability check: model must declare image input modality
       ├─ for each image:
       │    ├─ imageContentHash()       # content-based cache key (v2.1)
       │    ├─ cache hit? → reuse (index.json guards model/prompt/schema version)
       │    └─ transcribeOne():
       │         read bytes → size guard → durable attachment ref
       │         → llm.stream(provider, model, [image, prompt])
       │         → extract JSON (fenced-code tolerant)
       │         → schema validation (lightweight, hand-written)
       │         → build GeoVisionResult (discard `inferred` rows)
       ├─ visionOk = at least one image succeeded
       └─ return { status, images, degraded[], visionOk, markdown }
```

Every run is appended to `vision-runs.jsonl` (provider/model/status/schemaOk/
duration/error/rawText) for debugging and evaluation.

## Provider & credentials (user-configured)

- Default dev config: **SiliconFlow**, model **`Qwen/Qwen3-VL-8B-Instruct`**
  (Apache-2.0).
- **You bring your own API key.** Configure a provider route in your DSH
  `settings.yaml`, e.g.:
  ```yaml
  siliconflow:
    apiKeyEnv: SILICONFLOW_API_KEY
    baseURL: https://api.siliconflow.cn/v1
    api: openai-completions
    models:
      - id: Qwen/Qwen3-VL-8B-Instruct
        name: Qwen3-VL-8B
        input: [text, image]
  ```
  then export `SILICONFLOW_API_KEY=sk-...`. Any OpenAI-compatible vision
  endpoint works (Alibaba Bailian, local vLLM, ...) — change `provider`/`model`
  in `preset/agent.cordis.yml` (see `config.example.yaml`).
- The vision route is **independent** of the main agent model route.

## Guarantees

1. **No silent success**: `visionOk=false` + reasons when all images fail;
   `geo_solve` then falls back to figure captions and says so explicitly.
2. **Schema-validated**: hand-written validator rejects malformed model output
   (observed/uncertain/inferred categories, allowed fields, confidence range);
   `inferred` rows are discarded, not trusted.
3. **Content-hash cache**: same image content reuses results across questions;
   cache invalidation keys on model + prompt version + schema version.
4. **Runtime toggle**: `/geo/vision/status` and `/geo/vision/toggle` let you
   enable/disable transcription without restarting DSH; the teacher dashboard
   exposes the switch.

## Failure modes handled

| Symptom | Handling |
| :-- | :-- |
| Endpoint 503 / upstream unavailable | surfaced as real error (not a downstream json_parse), 1 retry on retryable codes, then degraded |
| Model without image modality | rejected at resolve time (no wrong-model calls) |
| Malformed/empty JSON | `json_parse`/`schema:` errors logged with rawText |
| Image too large / unreadable | per-image degraded, batch continues |

## Evaluation

Acceptance for the vision path: `vision-runs.jsonl` shows
`status:"success"` (or an explicit non-503 error), markdown non-empty, and a
cache hit on the second call.
