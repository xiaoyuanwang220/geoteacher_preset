# GeoTeacher Architecture

GeoTeacher is a **DeepSeek Harness (DSH) agent preset** — a Cordis composition
that turns a DSH agent into a geography-teacher assistant. Everything runs
inside DSH's plugin runtime: plugins register services, HTTP routes and model
tools; the agent preset (`preset/agent.cordis.yml`) mounts them under an
`isolate` realm so each session gets its own private service instances.

## Plugin map

```
preset/agent.cordis.yml  (geo group, isolate realm: geoKernel, geoVision)
├── geo-core      → provides geoKernel (bank parser/index, analysis engine,
│                    solver/judge/explainer skeletons, style profile)
├── geo-taxonomy  → taxonomy tree over KPS yaml (route /geo/taxonomy/tree)
├── geo-bank      → bank search/detail (routes /geo/bank/*)
├── geo-analysis  → explain-pipeline tools (geo_solve/judge/explain, geo_analyze)
├── geo-generator → style profile (geo_style_profile)
├── geo-vision    → provides geoVision (vision transcription service)
└── geo-ui        → teacher dashboard at /geo-teacher
```

Data flows between plugins through the **geoKernel** service (hosted by
`geo-core`); `geo-vision` is consumed by `geo-analysis`'s `geo_solve` to attach
image transcriptions. The kernel's `loadBank()` builds an on-disk index
(`question-index.json`) with a **parser-generation version + file-count +
mtime** freshness check, so the bank auto-rebuilds when files change.

## Explain pipeline (data flow)

```
 user: "讲解 25 年安徽卷第17题"
   │
   ▼
 geo_search_questions(region/year/questionNumber)   # find group
   ▼
 geo_solve(qid)          # stem-only + scaffold + vision transcription
   ▼
 geo_judge(qid, independentAnswer)   # open standard answer + score grid
   ▼
 geo_explain(qid, independentAnswer, judgeReport)   # teaching-script skeleton
   ▼
 final teaching script (four segments: locate → examine → solve → reflect)
```

The pipeline is orchestrated by the model; the **persona and skills** enforce
the order and the anti-leak discipline (no answers before `geo_solve` finishes,
no direct reads of the question-bank markdown).

## Model tools

| Tool | Purpose |
| :-- | :-- |
| `geo_taxonomy` | browse knowledge taxonomy |
| `geo_search_questions` / `geo_question_detail` | structured bank search / detail |
| `geo_analyze` / `geo_export_analysis` | exam analysis + blueprint / export markdown |
| `geo_solve` / `geo_judge` / `geo_explain` | the explain pipeline (flagship) |
| `geo_style_profile` | seven-dimension question-style profile |

## Verification

`npm run verify:geo` runs deterministic checks: plugin syntax / ESM import /
apply smoke with a mock ctx / dual-copy SHA-256 consistency / YAML structure /
isolate whitelist / route uniqueness / pipeline-discipline source assertions /
index-data assertions (no quoted qids, no fake stems), plus an optional runtime
smoke against a running DSH (`/geo/core/health` must return real JSON).

## Repository layout

```
preset/            dsh plugins + skills (the artifact to deploy)
sample-data/       sanitized sample questions + taxonomy subset
scripts/           geo-verify.mjs (checks), install.ps1 (deploy)
docs/en|zh         architecture, pipeline, vision, teaching docs
config.example.yaml  vision/provider/data-path knobs
```
