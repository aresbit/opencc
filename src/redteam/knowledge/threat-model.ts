/**
 * Threat-Model Knowledge — 威胁建模领域知识
 * 从 rtm-harness .claude/skills/threat-model/SKILL.md 提取
 */

export const THREAT_MODEL_SCHEMA = `\
# Threat Model Schema

## Section 1: System context
What the system does, who uses it, what trust boundaries exist.

## Section 2: Assets
What must be protected: data, compute, reputation, availability.

## Section 3: Entry points & trust boundaries
Table: entry_point | trust_level | notes

## Section 4: Threats
Table: id | threat | actor | surface | asset | impact | likelihood | status | controls

## Section 5: Deprioritized threats
Threats considered and explicitly scoped out, with rationale.

## Section 6: Open questions
What the code could not answer; seeds follow-up interviews.

## Section 7: Vulnerability evidence
Past CVEs, pentest findings, or scanner output that supports specific threat rows.

## Section 8: Recommended mitigations
Controls not yet deployed that would reduce likelihood or impact.
`

export const THREAT_MODEL_INTERVIEW_QUESTIONS = [
  {
    q: 'What are we working on?',
    fills: 'section 1 context, section 2 assets, section 3 entry points',
  },
  {
    q: 'What can go wrong?',
    fills: 'section 4 threat rows (id, threat, actor, surface, asset)',
  },
  {
    q: 'What are we going to do about it?',
    fills: 'section 4 impact/likelihood/status/controls; section 5 deprioritized; section 8 recommended mitigations',
  },
  {
    q: 'Did we do a good job?',
    fills: 'validate ranking, coverage check, section 6 open questions',
  },
]

export const THREAT_MODEL_BOOTSTRAP_STAGES = [
  'Parallel research swarm: read source, git history, CVEs',
  'Synthesize sections 1-3 + vulnerability evidence table',
  'Generalize vulnerabilities into threat classes',
  'STRIDE gap-fill: ensure each category has coverage',
  'Emit THREAT_MODEL.md conforming to schema',
]

export const STRIDE_CATEGORIES = [
  { id: 'S', name: 'Spoofing', question: 'Can an attacker pretend to be someone else?' },
  { id: 'T', name: 'Tampering', question: 'Can an attacker modify data or code?' },
  { id: 'R', name: 'Repudiation', question: 'Can an attacker deny doing something?' },
  { id: 'I', name: 'Information Disclosure', question: 'Can an attacker read sensitive data?' },
  { id: 'D', name: 'Denial of Service', question: 'Can an attacker crash or slow the system?' },
  { id: 'E', name: 'Elevation of Privilege', question: 'Can an attacker gain unauthorized access?' },
]

export const THREAT_MODEL_EXAMPLE = `\
## Example threat row

| id | threat | actor | surface | asset | impact | likelihood | status | controls |
|---|---|---|---|---|---|---|---|---|
| T001 | Attacker achieves RCE via untrusted media parsing | unauthenticated remote | file upload / media endpoint | server, user data | HIGH | MEDIUM | open | input validation, sandboxing |
`

export const THREAT_MODEL_LITMUS_TEST = `\
Litmus test: If patching one line of code makes an entry disappear, it was
a vulnerability, not a threat. A threat ("attacker achieves RCE via untrusted
media parsing") still stands after every known bug is fixed; a vulnerability
("dr_wav.h:412 doesn't bounds-check chunk_size") does not.
`
