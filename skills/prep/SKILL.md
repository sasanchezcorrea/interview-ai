---
name: prep
description: Build the candidate dossier that Interview AI uses to answer in the user's real voice and experience. Reads LifeOS identity, resume, projects, TELOS and engram memories, matches them to a pasted job description, and writes $IAI_USER_DIR (default ~/.interview-ai, or the LifeOS folder when it exists)/dossier.md + jd.md. USE WHEN the user says "interview-ai prep", "prepara interview ai", "prepárame para la entrevista de X", "dossier de entrevista", "prepare my interview dossier", "load the job description for the copilot", or pastes a job offer and asks Interview AI to use it. NOT FOR the TELOS context interview (/interview) or resume writing.
---

<!-- The product ships in English; the Spanish trigger phrases stay bilingual on purpose,
     because the principal talks to Claude in Spanish. -->

# /interview-ai:prep — build the dossier

The live brain runs as `claude -p` without CLAUDE.md, memories or MCP, so everything it may know about the candidate has to be distilled here first. Target: a dossier a stranger could use to answer as the candidate, honestly, in under 25 words per cue.

## Inputs

- The job description / role / company pasted by the user (ask for it if missing; a one-line role is enough to start).
- `~/.claude/LIFEOS/USER/PRINCIPAL/PRINCIPAL_IDENTITY.md`, `RESUME.md` (if present), `~/.claude/LIFEOS/USER/PROJECTS.md`, `~/.claude/LIFEOS/USER/TELOS/TELOS.md`.
- Engram: run `mem_search` (all_projects: true, match_mode: any) with 3-5 keyword sets taken from the job description (stack, domain, seniority signals, e.g. "multi-agent orchestration", "kubernetes production", "RAG vectorization", "MCP server"). Pull the top decisions, bugs fixed and architectures: those are the concrete stories.

## Steps

1. Read the input files. Skip placeholders marked `(interview …)` or `[…]`; never invent content for them.
2. Save the job description verbatim to `$IAI_USER_DIR (default ~/.interview-ai, or the LifeOS folder when it exists)/jd.md` under a `# Job / meeting context` heading, followed by 5-8 bullets: what the role really tests, likely question themes, and vocabulary to mirror.
3. Write `$IAI_USER_DIR (default ~/.interview-ai, or the LifeOS folder when it exists)/dossier.md` with these sections, in English (the interview language), even when the user writes to you in another language, each fact tagged with its source file or memory id:
   - **Profile in 3 lines** — who the candidate is, seniority, current focus.
   - **Stack and honest level** — technologies with honest depth (production / prototype / read about). Honesty beats breadth: the cue must never claim more than this table.
   - **STAR stories (6-8)** — one paragraph each: situation, task, action, result with numbers. Prefer engram-sourced stories (real incidents, decisions, metrics). Map each to the role's likely themes.
   - **Technical positions** — opinions the candidate actually holds (from TELOS narratives/beliefs, memories): e.g. simplicity over sophistication, verification doctrine, multi-tenant isolation first.
   - **Questions the candidate will ask** — 4-6 sharp questions for the interviewer, tied to the JD.
   - **Weak areas and how to pivot** — gaps versus the JD and the honest pivot sentence for each.
   - **Phrases in their voice** — 5 short phrases in the candidate's natural register, both languages if they interview in two.
4. Keep the dossier under ~1,500 words; it rides in the system prompt of every call.
5. If the sidecar is running (`curl -s http://127.0.0.1:31338/health`), `POST /reset` so the brain starts a fresh session with the new dossier; otherwise tell the user it loads on next start.
6. Report: what went in, which sections are thin because the source files are still placeholders, and suggest `/interview` to fill PRINCIPAL_IDENTITY if it is still a stub.
