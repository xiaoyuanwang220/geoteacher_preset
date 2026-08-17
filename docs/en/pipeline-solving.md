# The Question-Explaining Pipeline (solve → judge → explain)

The flagship feature: a three-stage pipeline that lets a teacher ask *"explain
this gaokao question"* and receive a verified, teaching-ready walkthrough —
without the model silently cribbing the official answer.

## Why three stages

A single "explain this" prompt invites leakage: the model reads the answer and
retrofits its reasoning. GeoTeacher splits the task so the model's own
reasoning is produced *before* it ever sees the answer, then verifies and
recomposes.

```
① geo_solve  — INDEPENDENT SOLUTION (no answers)
    returns: stem-only problem (material + sub-question stems/options),
             reasoning scaffold (question framework / focus elements /
             dimension scan over material evidence),
             vision transcription if the question has figures.
    rule: the model must finish its answer before reading any answer/analysis.

② geo_judge  — VERIFICATION (opens the answer)
    input: qid + the model's independentAnswer.
    returns: standard answer + analysis + score points + coverage grid +
             distractor targets, for the model to score its own answer.

③ geo_explain — TEACHING RECOMPOSITION
    input: qid + independentAnswer + judgeReport.
    returns: a four-segment teaching-script skeleton
             (题目定位 locate → 审题 examine → 破题 solve → 反思迁移 reflect)
             with dimension scan, variant questions, verification summary.
```

The four-segment teaching script, question-type-aware organization (cause /
effect / process / compare / evaluate / measure / describe / trend), and
distractor analysis for choice questions are described in
`docs/zh/讲题功能设计.md` (Chinese) and demonstrated in the solver/explainer
skills (`preset/skills/`).

## Anti-leak design (why it works)

1. **Data separation at the source**: `geo_solve`'s payload never includes the
   `answer`/`analysis` fields; the judge stage is the only place that opens
   them, and `geo_explain` only consumes the verified outcome.
2. **No derived leak in scaffolds**: the solver scaffold is built only from
   stem + material (question framework, focus elements, dimension scan) —
   no distractor clues derived from the analysis.
3. **Single image path**: `geo_solve` auto-attaches the vision transcription;
   there is no separate "read the figure" tool, avoiding duplicate reads.
4. **Discipline layer**: the persona and the solver/explainer skills state a
   hard rule — *fetch questions only through the geo tools; never `read` the
   question-bank markdown directly* (it contains answers/analysis).
5. **Verification artifacts**: `npm run verify:geo` asserts the anti-leak
   invariants statically (no `distractorClues`, no `geo_extract_images`,
   `independentAnswer` orchestration present).

## Question-bank parsing & index

`geo-core` parses question-group markdown pages:

- frontmatter (region / year / question_numbers / question_type ...)
- material section, per-question stems (**题干** / **小问** markers), options,
  answer, analysis, knowledge attribution, and a `MANAGED-KM` YAML block
  (knowledge-point mapping with roles/weights/evidence).
- Known issues fixed along the way: the KM block is skipped by the main parse
  loop (it used to overwrite `question_id` with a double-quoted value), the
  stem now reads the real content (group 2), and the on-disk index carries a
  parser-generation version plus an mtime freshness check.

## Evaluation

The acceptance path for the pipeline (see `docs/zh/讲题评测方案.md`) asserts:
one clean `geo_solve` hit, ≤3 geo-tool round-trips, no debug tool calls
(glob/pwsh/read) in the trajectory, no direct question-bank file reads, and a
vision success (or explicit non-503) record.
