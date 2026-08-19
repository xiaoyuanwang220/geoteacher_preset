# Dependencies & Deployment

## What this repository is

**GeoTeacher** is a **DeepSeek Harness (DSH) agent-preset plugin layer** — a
set of Cordis plugins (`preset/agent.cordis.yml` + `preset/plugins/*`) and
teaching skills (`preset/skills/*`) that turn a DSH agent into a
geography-teacher assistant. Its two flagship capabilities:

1. **Question-explaining pipeline** (`geo_solve → geo_judge → geo_explain`)
   with an anti-leak design: the solver sees only the stem (no answers or
   analysis), the judge opens the standard answer for verification, and the
   explainer recomposes a teaching script.
2. **Vision transcription** (`geo-vision` adapter): question images are passed
   to the host-provided `dshVision` service and mapped back to GeoTeacher's
   evidence contract with explicit graceful degradation.

## Runtime dependency: DeepSeek Harness (DSH)

- DSH is the **runtime host** and is **not bundled** here. Install it from its
  own distribution (see its license/terms; this project references it as a
  dependency only).
- The plugins run inside DSH's Cordis composition and consume DSH services:
  `fs`, `webServer`, `tools`, `agentPresets` (preset mounting), and
  `dshVision` (vision). The host vision component owns `llm`, attachments,
  provider routing, caching and validation. GeoTeacher has no vendor SDK.

### Directory layout expectation

DSH mounts agent presets from `<DSH_HOME>/.agent-presets/<id>/`. `scripts/install.ps1`
copies this repository's `preset/` (as `geo-teacher`) into that location.

## Your own question bank & knowledge graph (not bundled)

The plugins read two external data sources:

| Source | Path (configurable via `agent.cordis.yml`) | Format |
| :-- | :-- | :-- |
| Knowledge taxonomy (KPS) | `knowledgeBasePath` (default `<KB_ROOT>/config`) | `knowledge_taxonomy_*.yaml` (domain → theme → knowledge unit) |
| Question bank | `questionBankPath` (default `<KB_ROOT>/obsidian_vault/04_题目`) | markdown, one question-group page per file; see `sample-data/questions/` |

Point these at **your own** data. The repo ships with 2 sanitized sample
questions + a minimal taxonomy subset only; the development question bank
(province/year grouped gaokao pages with MANAGED-KM annotations) is **not**
redistributed.

## Host vision service & credentials

- The DSH host must publish a compatible `dshVision` service before this preset
  mounts. Without it, the GeoTeacher adapter stays disabled and reports an
  explicit degraded status.
- Provider, model, API credentials, attachment handling, cache and retry policy
  are configured in the host vision component, not in this preset.
- The host should also expose `vision_inspect` and `vision_ocr` when users need
  to submit standalone images outside the question bank.
- See `config.example.yaml` and `docs/en/vision.md`.

## Runtime requirements

- Node.js (for the verify/checks scripts; DSH itself provides its own Node
  runtime).
- Windows PowerShell recommended for `scripts/install.ps1`; the plugin code is
  cross-platform (no `import` of host deps), but paths in docs use Windows
  conventions.

## Network

- Vision network access is owned by the host `dshVision` component.
- LLM calls go through your DSH model route.
