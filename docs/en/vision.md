# Vision Transcription (`geo-vision`)

`geo-vision` is the GeoTeacher adapter for the host-provided `dshVision`
service. It resolves question-bank image references, asks the host for
evidence-only OCR/inspection, maps the generic `VisionResult` into the existing
GeoTeacher contract, and lets `geo_solve` attach that evidence to the problem.
A failed or unavailable host service is reported explicitly.

## Data flow

```text
geo_solve(qid)
  └─ geoVision.extract(qid, { problem })
       ├─ kernel.imageRefs(qid)          # markdown image refs → disk paths
       ├─ build a stem-only task context
       ├─ dshVision.inspect({
       │    inputs, mode: "ocr",
       │    policy: { evidenceOnly: true, allowInference: false }
       │  })
       ├─ map generic evidence by asset index
       └─ return { status, images, degraded[], visionOk, markdown }
```

`mode: "ocr"` requests one evidence-transcription pass and avoids a redundant
inspect-plus-OCR sequence. Model routing, image loading, attachments, caching,
retries, validation and diagnostics are owned by the host `dshVision`
implementation.

## Host prerequisite

The DSH host composition must publish a compatible service named `dshVision`
before this preset mounts. The service must provide `inspect(options)` and may
provide `health()`. Provider/model selection and credentials are configured in
that host component, not in `preset/agent.cordis.yml`.

For images supplied directly by a user rather than referenced by a question
bank qid, the host should expose `vision_inspect`; pure-text scans may use
`vision_ocr`. The GeoTeacher skill forbids bypassing these tools with a raw
file read or direct handoff to the main model.

## Guarantees

1. **No silent success**: `visionOk=false` and degradation reasons are returned
   when no image yields usable evidence.
2. **Evidence-only policy**: the adapter requests `allowInference: false` and
   maps only `observed` and `uncertain` evidence.
3. **Stem-only context**: the adapter sends material, stems and options, not
   standard answers or analysis.
4. **Runtime toggle**: `/geo/vision/status` and `/geo/vision/toggle` control the
   adapter without changing the host vision configuration.

## Failure modes handled

| Symptom | Handling |
| :-- | :-- |
| `dshVision` unavailable at mount | Adapter starts disabled and reports degraded status |
| Host returns no usable result | `visionOk=false` with host degradation details |
| Some images are uncertain | Uncertainty text and reasons remain visible |
| Adapter throws | Returns an explicit error instead of fabricated evidence |

## Evaluation

Acceptance for the integration path: `/geo/vision/status` reports an available
downstream service, a figure question returns non-empty evidence or explicit
degradation, and standalone image tools follow the host component's contract.
