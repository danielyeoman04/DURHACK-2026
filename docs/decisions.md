# Decision Log

> A running record of choices that affect how the project is built.
> **Newest entries go at the top.** Never rewrite history: if a decision changes,
> add a new entry and mark the old one `Superseded by D-00X`.
>
> **For agents:** read this before proposing architecture, libraries or scope changes.
> Don't re-litigate an `Accepted` decision unless asked. Append an entry when the
> team settles something non-trivial (stack, data model, API shape, scope cut).

## Index
| ID | Title | Status | Date |
|----|-------|--------|------|
| D-001 | Example: use Python + FastAPI for the backend | Accepted | 2026-11-14 |

---

## Entry template
Copy this block to the top of the log, below this line, for each new decision.

```
### D-00X: <short title>
- **Date:** YYYY-MM-DD
- **Status:** Proposed | Accepted | Superseded by D-00Y
- **Decided by:** <names>
- **Context:** What forced a choice? What constraints applied?
- **Decision:** What we're doing, in one or two sentences.
- **Alternatives considered:** Option A (why not), Option B (why not)
- **Consequences:** What this makes easier or harder; follow-up work.
```

---

### D-001: Example: use Python + FastAPI for the backend
- **Date:** 2026-11-14
- **Status:** Accepted
- **Decided by:** <names>
- **Context:** Need a quick API with minimal setup; the team all knows Python.
- **Decision:** Backend is Python with FastAPI. Delete this example once real entries exist.
- **Alternatives considered:** Node/Express (less team familiarity); Flask (fewer built-in docs and validation).
- **Consequences:** Pydantic models define the API schema; frontend consumes the generated OpenAPI spec.
