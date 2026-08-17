# GeoTeacher Plugin Manifest — dsh plugins

**GeoTeacher** is published as a set of **DeepSeek Harness (DSH) agent-preset
plugins** ("dsh plugins"). Every plugin below is a Cordis plugin that runs
inside the `geo-teacher` agent preset (see `preset/agent.cordis.yml`); the
preset is mounted by DSH under `<DSH_HOME>/.agent-presets/geo-teacher/`.

| Plugin (id) | File | Provides | Routes | Model tools |
| :-- | :-- | :-- | :-- | :-- |
| `geo-core` | `preset/plugins/core/index.js` | `geoKernel` service: bank parser & index (mtime-fresh), analysis engine, solver/judge/explainer skeletons, style profile | `/geo/core/health` | — |
| `geo-taxonomy` | `preset/plugins/taxonomy/index.js` | taxonomy tree over KPS yaml | `/geo/taxonomy/tree` | `geo_taxonomy` |
| `geo-bank` | `preset/plugins/bank/index.js` | question-bank search / detail | `/geo/bank/search`, `/geo/bank/detail` | `geo_search_questions`, `geo_question_detail` |
| `geo-analysis` | `preset/plugins/analysis/index.js` | explain-pipeline tools + analysis/export | `/geo/analysis/*` | `geo_analyze`, `geo_export_analysis`, `geo_solve`, `geo_judge`, `geo_explain`, `geo_style_profile`* |
| `geo-generator` | `preset/plugins/generator/index.js` | style profile / question generation support | `/geo/generator/style` | `geo_style_profile` |
| `geo-vision` | `preset/plugins/vision/index.js` | `geoVision` service: vision transcription (provider-agnostic, schema-validated, cached, degradable) | `/geo/vision/status`, `/geo/vision/toggle` | — (consumed by `geo_solve`) |
| `geo-ui` | `preset/plugins/ui/index.js` (+`page.html`) | teacher-facing dashboard | `/geo-teacher` | — |

\* `geo_style_profile` is registered by `geo-generator`; listed here for the
full tool picture.

## Explain pipeline contract (the flagship)

```
① geo_solve(qid)   → stem-only problem + scaffold (+ vision transcription)
② geo_judge(qid, independentAnswer) → opens standard answer/analysis + score grid
③ geo_explain(qid, independentAnswer, judgeReport) → teaching-script skeleton
```
Anti-leak rules are enforced by design (no answers before solve completes) and
by discipline text in the persona/skills (no direct reads of the question-bank
markdown). See `docs/en/pipeline-solving.md`.

## Vision contract (the flagship)

`geo_solve` auto-attaches an image transcription via `geoVision.extract(qid)`:
OpenAI-compatible vision endpoint → schema validation → content-hash cache →
run log (`vision-runs.jsonl`) → explicit `visionOk`/degraded flag (never
silently fakes success). See `docs/en/vision.md`.