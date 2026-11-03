### Description

Please provide a concise description of the changes introduced by this pull request, including the motivation and architectural rationale.

---

### Related Issues
<!-- Link open issues here using GitHub keywords, e.g. Closes #12, Fixes #34 -->
Closes #

---

### Type of Change
- [ ] `feat`: A new feature or capability
- [ ] `fix`: A bug fix or defect resolution
- [ ] `perf`: Performance improvement
- [ ] `refactor`: Code reorganization without behavioral changes
- [ ] `docs`: Documentation updates or additions
- [ ] `test`: Adding or correcting tests
- [ ] `ci`: CI/CD workflow or automation changes
- [ ] `chore`: Maintenance tasks or dependency updates

---

### Security & Invariant Checklist
<!-- Confirm compliance with YOUPI PG V2 architectural and security invariants (see AGENTS.md) -->
- [ ] **No Force-Success Endpoint**: Payment verification remains strictly bound to verified banking observations (SMS/Gmail).
- [ ] **Webhook Raw Payload Integrity**: HMAC signature is computed over raw unparsed payload bytes (`X-Gateway-Signature: sha256=...`).
- [ ] **Secret Isolation**: No private keys, database credentials, or observer tokens exposed to client scripts.
- [ ] **Device & Token Binding**: Device access and customer session checks fail closed on state-changing operations.
- [ ] **Node.js Engine Target**: Code runs compatibly with Node.js >= 22.5.0 (`node:sqlite`).

---

### Verification Checklist
- [ ] `npm run typecheck` passes cleanly with 0 TypeScript errors.
- [ ] `npm test` passes 100% cleanly across all curated test suites.
- [ ] Changes inspected via `git diff` with no debug logs, secrets, or temporary files.
