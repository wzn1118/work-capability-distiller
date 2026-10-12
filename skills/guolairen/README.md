# 过来人 · guolairen (restored original Skill)

This directory restores the **original, unabridged 2,316-line `guolairen v1.0.0`** from the user's retained source. It is kept as an independent Skill and does not overwrite the existing aftercode conversation-distillation pipeline.

## Install

Copy this directory into your local Skill directory (such as `~/.codex/skills/guolairen/`). Ensure the `SKILL.md` filename is unchanged and load it from your compatible Agent environment.

Trigger example: “按过来人 Skill，审计这个 AI 产品想法的真实 Core Job、已有替代和可验证的剩余能力”。

## Product idea audit pipeline

```text
Idea / Repo / Workflow
→ Scope Lock
→ Job Compiler
→ Capability Graph (3–12 capabilities)
→ Prompt Simulator + real task execution + independent Judge
→ Agent / Product / Native / OSS evidence investigation
→ Candidate → Triage → Deep Read → Claim → Verification → Coverage → Audit
→ Evidence Ledger
→ Coverage normalization + Subtraction
→ REMOVE / KEEP / Residual Job V2
→ BUILD / PIVOT / COMMODITY / KILL
→ One Killer Experiment
```

## Work-to-capability distillation pipeline

```text
Sessions / Trace / Artifacts / Git / Tool events
→ Evidence graph & provenance
→ Work Capability IR
→ Procedure IR (dataflow, control-flow, parameterization, tool resolution)
→ Skill / MCP / Agent / UI target selection
→ Original Replay
→ Held-out evaluation
→ Canary release and runtime feedback
```

## Non-negotiable gates

- A search result is a **candidate**, not verified evidence; do a source deep-read and preserve contradictions.
- Coverage greater than 0.20 requires an identifiable evidence record. Related pages from one vendor do not count as independent coverage.
- LLM ability is scored on actual target tasks by an independent judge; self-assessment is invalid.
- Effective coverage defaults to `max(llm, product × 0.95, native, oss × 0.75)`; never add the four coverage scores.
- Missing coverage or verification must stay explicitly **UNKNOWN / RESTRICTED**.
- Procedure replay, held-out and canary gates require actual run artifacts; a parser pass is not a real replay.
- A verdict is subordinate to evidence, and a BUILD verdict is not permission to build a bloated product.

## Integration boundary

The top-level repository currently contains the **aftercode** session-forensics and multi-target capability-compiler stack. This directory restores the missing *upstream opportunity and substitution-audit Skill* as a separate entrypoint. Future runtime integrations should consume the existing Trace / Capability IR and preserve evidence IDs; they must not silently declare G3/G4/G5 passed.

## Source fidelity

The restored `SKILL.md` matches the original 38,704-byte Library source, including its final newline. It has been restored on a separate branch to preserve `master` and existing aftercode code.
