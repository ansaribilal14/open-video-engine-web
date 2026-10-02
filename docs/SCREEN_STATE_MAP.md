# SCREEN STATE MAP — OVE Studio Web v0.1.0

Every screen × state × control. `✓` = enabled, `⨯` = disabled, `—` = absent.
No dead controls: a control exists only when the state makes it real.

## Home

| State | Project list | New project | Open | Delete | Settings |
|---|---|---|---|---|---|
| loading | skeleton text | ✓ | — | — | ✓ |
| empty | "No projects yet." | ✓ | — | — | ✓ |
| populated | cards | ✓ | ✓ (⨯ if folder missing) | ✓ (confirm) | ✓ |
| server unreachable | error snackbar | ✓ (will error) | — | — | ✓ |

## Editor

| State | Preview | Transport | Timeline | Import | Export | Undo |
|---|---|---|---|---|---|---|
| no media | empty copy | ✓ (renders empty composite) | ruler only | ✓ | ✓ (sheet blocks empty span) | ⨯ (depth 0) |
| populated | engine PNG at playhead | ✓ | clips + playhead | ✓ | ✓ | ✓ (⨯ at depth 0) |
| clip selected | unchanged | ✓ | ring + handles + context bar | ✓ | ✓ | ✓ |
| uploading | unchanged | ✓ | ✓ | ⨯ (progress row) | ✓ | ✓ |
| engine busy (export) | last frame | ✓ (requests typed EngineBusy) | ✓ | typed EngineBusy on next mutation | sheet modal | typed EngineBusy |
| browser reload | — | — | — | Home → Open = idempotent re-open of the durable state (P-2) | — | restored from engine |

## Export sheet

| State | Content |
|---|---|
| idle | three route cards; segment route requires a clip selection; empty-span disables all with explanation |
| running | indeterminate bar + "no progress estimate / no cancel" copy (gap #6) |
| done | file, size, frames/samples, engine sha256, Verify checksum (in-browser), Download |
| failed | typed kind + message via snackbar; sheet closes |

## Error envelope

One shape everywhere: `{ok:false, kind, message}` — kinds `BadRequest`,
`EngineBusy`, `NoSession`, `ProjectOpen`, `ProjectExists`, `StorageError`,
`NetworkError` (client) and the engine taxonomy mapping (audit §8): 
`ImportRejected`, `UnknownAsset`, `TimelineError`, `RenderFailed`,
`ExportFailed`, `SeamError`, `NothingAtTime`, `NoAudioStream`,
`NonSampleExactCut`, `RetimeUnsupported`, `KeyframeRange`, `EngineInternal`.
