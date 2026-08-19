# GeoTeacher — dsh plugins for a Geography-Teacher Agent

**GeoTeacher** is a set of **DeepSeek Harness (DSH) agent-preset plugins**
("dsh plugins") that turn a DSH agent into a high-school geography-teacher
assistant. MIT licensed.

> **dsh plugin** — this repository is a plugin layer for the
> [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) agent runtime. It
> does not bundle DSH; install DSH yourself, then mount this preset (see
> [DEPENDENCIES.md](DEPENDENCIES.md) and Quick Start below).

## Features

### 1. Question-explaining pipeline (`geo_solve → geo_judge → geo_explain`)

Explain a gaokao (高考) question the way a teacher would — with an
**anti-leak design**:

- `geo_solve` returns **stem-only** problem + reasoning scaffold (no answers,
  no analysis, no derived distractor clues) + automatic figure transcription;
- `geo_judge` then opens the standard answer + score grid so the model
  **verifies its own independent answer**;
- `geo_explain` recomposes a four-segment **teaching script**
  (locate → examine → solve → reflect) with question-type-aware organization,
  dimension scan and variant questions.

The pipeline is enforced both by the payload contracts and by discipline text
in the persona/skills (fetch questions only through geo tools; never read the
question-bank markdown directly). →
[docs/en/pipeline-solving.md](docs/en/pipeline-solving.md)

### 2. Vision transcription (`geo-vision`)

Read figure images from exam questions into structured evidence with explicit
graceful degradation. GeoTeacher now contains only a thin adapter: generic
image loading, OCR, model routing, caching and validation belong to the host's
`dshVision` service.

- question-bank figures are transcribed automatically by `geo_solve`;
- standalone images use host tools such as `vision_inspect` or `vision_ocr`;
- `/geo/vision/status|toggle` controls the GeoTeacher adapter only;
- model/provider credentials remain host-managed and are not stored here.
  →
  [docs/en/vision.md](docs/en/vision.md)

### Also included

- Question bank & knowledge-taxonomy search (`geo_search_questions`,
  `geo_question_detail`, `geo_taxonomy`)
- Exam analysis + question-design blueprint (`geo_analyze`)
- Seven-dimension style profile (`geo_style_profile`)
- Teacher dashboard at `/geo-teacher`
- Deterministic verification: `npm run verify:geo`

## Quick Start

Prerequisites: a running **DeepSeek Harness** (DSH) instance; Node.js for the
check scripts; PowerShell (Windows) for the install helper.

```powershell
# 1. Deploy the preset into DSH's agent-presets directory
powershell -ExecutionPolicy Bypass -File scripts/install.ps1

# 2. Configure data paths (replace the <...> placeholders)
#    preset/agent.cordis.yml :
#      knowledgeBasePath: <KB_ROOT>/config
#      questionBankPath:  <KB_ROOT>/obsidian_vault/04_题目
#      outputPath:        <WORKSPACE>/outputs

# 3. Ensure the DSH host provides the dshVision service and vision tools.
#    Provider/model credentials are configured in that host component.

# 4. Restart DSH → open a new session on the geo-teacher preset →
#    ask: "讲解 25 年安徽卷第17题"  (or "explain Anhui 2025, question 17")
```

Sanity check (no DSH needed):

```powershell
npm run verify:geo -- --source   # or: npm test
```

## Sample Data

`sample-data/` contains two sanitized sample questions
(**2024 Shandong Q16**, **2025 Anhui Q17**) with original (MIT) answers and
analysis, plus a minimal taxonomy subset — enough to try parsing, search and
the explain pipeline. Exam **figures are not redistributed**: to test the
vision path, put your own copies under `sample-data/images/` (git-ignored).
Point the plugins at **your own** question bank for real use
([DEPENDENCIES.md](DEPENDENCIES.md)).

## Repository Layout

```
preset/              dsh plugins + skills (the artifact to deploy)
sample-data/         sanitized samples + taxonomy subset
scripts/             geo-verify.mjs (checks), install.ps1 (deploy)
docs/en, docs/zh     architecture · pipeline · vision · teaching docs
config.example.yaml  data paths / vision-adapter settings
```

## Verification

`npm run verify:geo` — plugin syntax / ESM import / apply smoke / dual-copy
hash / YAML / isolate whitelist / route uniqueness / anti-leak assertions /
index-data assertions / runtime smoke (JSON-checked). See
[docs/en/architecture.md](docs/en/architecture.md).

## License & Notices

- Code & docs: **MIT** — see [LICENSE](LICENSE).
- Third-party components and usage notes (DSH runtime, vision models, sample
  exam questions): [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Dependencies & deployment: [DEPENDENCIES.md](DEPENDENCIES.md).
