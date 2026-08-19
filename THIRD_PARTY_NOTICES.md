# Third-Party Notices

This project builds on third-party software and assets. Their licenses and
terms apply as follows; this project itself is MIT licensed (see LICENSE).

## DeepSeek Harness (DSH) — runtime host

- **Project**: DeepSeek Harness (DSH), the agent runtime this repository plugs into.
- **Role**: This repository is a *DSH agent-preset plugin layer* (`preset/`). The
  plugins register tools, web routes, and a persona through DSH's plugin
  composition (Cordis). DSH is **not** bundled with this repository.
- **License**: Follow the license/terms of the DSH distribution you install.
  See its repository/documentation. This project only documents the dependency
  and does not redistribute DSH source code.

## Host vision component and models (not bundled)

- The `geo-vision` plugin is an adapter for the host-provided `dshVision`
  service. This repository does not bundle that host component, a vision model,
  model weights, or a provider SDK.
- The host operator chooses the vision model and provider. Their respective
  licenses and terms apply independently.
- API keys and credentials belong to the host configuration and are never
  stored by this repository.

## Sample data

- The sample exam questions under `sample-data/questions/` are **public exam
  questions** (2024 Shandong / 2025 Anhui geography gaokao). The stems are
  public official exam text; answers & analysis in the samples are **original
  to this project** (MIT).
- The **figures** in the exam papers are **not redistributed**. If you want to
  test the vision pipeline, place your own copies under `sample-data/images/`
  (ignored by git).
- The full question bank and knowledge graph used in development are **not**
  included; see DEPENDENCIES.md for how to point the plugins at your own
  question bank.

## DeepSeek / Qwen model chats

- Model inference during "solving / judging / explaining" runs on whatever LLM
  your DSH deployment routes to. No model weights or providers are bundled.

---

If a component above is yours and you believe the notice is incomplete, please
open an issue.
