# Reject placeholder review approval

The owner requested a fix after PR #94 review run 44296391691 produced pass/test/test. Settings and discovery remain unchanged/off; no model or repair is authorized during preparation. Both consumed #93 reviews and original artifact stay intact.

## Decision

Keep the existing four-field JSON shape. Add bounded text-quality checks in artifact validation and reuse full artifact validation when the gate reads retained feedback. Require 60-character summaries, 30-character finding explanations, several distinct words, and reject sample-only/repetitive filler after Unicode normalization. Prompt for concrete paths, criteria, supplied CI evidence and limitations, with empty findings when none exist. Keep honest inspection blockers representable. These checks reject obvious non-evidence; they cannot prove that an arbitrary long model answer is truthful or complete.

Alternatives: another unchanged run can waste a consumed attempt without fixing acceptance; a new multi-field review protocol would require a broader migration. The focused guard plus prompt addresses the observed failure while keeping current provenance and output shape.

## Trust and history

Collector, controller/dependency assessment and gate all use the same validator. Ledger schema remains readable; the gate denies missing, malformed, stale, failed or placeholder recorded review content without mutating it. No counter resets, allowance changes or fabricated review replacements. A new combined owner brief covers the recovery feature and this newly requested global guard; #93 remains frozen with both reviews. PR #94 stays draft. A future review is a separate authorization and must assess the full combined scope.

Trusted main governs this PR's own review until merge. Its old validator cannot enforce candidate guard code; the operator must reject placeholder artifacts manually and accept only actual substantive new review output. No self-issued check, protection bypass or code-from-PR replacement of trusted gate is allowed.
