# AILedger Charter — v1.3

## Purpose

AILedger exists to make AI systems in regulated industries auditable in ways that catch actual harm to real people. Not to generate paperwork that satisfies regulators while harm continues.

## Scope: what AILedger does and does not do

AILedger sits at the audit layer of AI-influenced decisions, not the decision layer or the remediation layer:

- **Detection (yes):** Identify bias, drift, disparate impact, and other failure modes in AI-influenced decisions, with thresholds anchored to the published standards maintained in [STANDARDS.md](./STANDARDS.md) — the EEOC four-fifths rule (29 CFR 1607), NIST AI RMF 1.0, ISO/IEC 42001, and EU AI Act Articles 12, 19, and 26.
- **Reporting (yes):** Produce structured Decision Event records, Integrity Chain verifications, and statistical findings as audit-grade evidence usable by customers, regulators, and adversarial reviewers.
- **Remediation (no, by design):** AILedger does not — and will not build features to — propose, recommend, or implement remediation for the AI behavior it detects. Remediation is the customer's responsibility, executed by their compliance, legal, and regulatory counsel. This separation is structural: an audit substrate that also remediated would mean customers grading their own work, which is exactly the audit theater this Charter exists to prevent.

AILedger facilitates accountability. It does not absolve it.

## Working as intended

Users of AILedger detect bias, drift, and disparate impact in their AI systems before regulators or lawsuits do. Affected populations - job applicants, loan applicants, patients, students - experience fewer AI-caused harms because the systems affecting them are monitored substantively. Regulators trust AILedger output (Detection Events, Integrity Chain verifications, Witnessed Inferences) as evidence in enforcement actions.

## Failure mode

Customers use AILedger Detection Events, Integrity Chain verifications, and Witnessed Inferences as legal cover. Audit trails are intact and meaningless. Detection thresholds are configured to suppress findings. The product becomes shorthand for "we have a compliance tool" without changing AI behavior. Affected populations are harmed at the same or higher rates because the regulatory pressure that would have forced change is absorbed by the appearance of compliance.

## Customers we refuse

- Companies whose underlying AI use is itself the harm (predictive policing, social scoring, deceptive targeting of vulnerable populations)
- Companies that request detection configurations specifically designed to suppress findings
- Companies whose primary purpose is paperwork generation rather than catching problems
- Companies under active enforcement action who want AILedger as an improper litigation defense in bad faith to suppress harm that the regulation is meant to prevent rather than showing ongoing accountability under the regulation.

## Features we won't build

- Configurable detection thresholds that allow suppression below standards-aligned defaults*
- "Compliance mode" that generates reports without underlying detection
- Removal of required-action workflows for detected events
- Selective logging that excludes specific decision categories at customer request

*Specific standards anchoring detection defaults are listed in [STANDARDS.md](./STANDARDS.md). The principle of standards-anchoring is the Charter commitment; the specific list is maintained in that document and updates without requiring board approval.

## Decisions requiring board review

- Weakening any detection primitive below its launch sensitivity
- Accepting a customer from a refused category
- Subjective determinations of bad-faith use per Customers-we-refuse §4 (including but not limited to bad-faith litigation defense)
- Removing or making optional any required-action workflow
- Acquisition offers or exit decisions that would change product direction
- Any amendment to this charter (requires unanimous Board of Directors approval)

## Exit conditions

- Detection primitives demonstrably fail to catch harm in real customer deployments and can't be fixed
- Regulatory environment shifts such that AILedger's substantive features become commercially impossible to sell against competitors offering audit theater
- Founder no longer able to refuse customers without bankruptcy
- Majority of the Board of Directors no longer voting to maintain refusals

## Public commitment

This charter is published from day one. Customers, regulators, and the public can hold AILedger accountable to it. Amendments are versioned publicly so changes are visible.

## Review cadence

At a minimum, reviewed annually by Board of Directors.

## Regulatory context

Updated 2026-05-20, post-Digital Omnibus. The binding obligations on August 2, 2026 are Article 27 FRIA (deployers in credit scoring, insurance pricing, public services, education, and employment), Article 50 transparency, financial-sector high-risk AI, and GPAI provider obligations. Most other Annex III standalone high-risk obligations move to December 2, 2027, and Annex I product-embedded systems to August 2, 2028. This narrows the immediate regulatory surface but does not change AILedger's principle: catch actual harm, not paperwork. The FRIA living-document requirement makes continuous evidence infrastructure more important, not less.

This section is informational. The principles, refused-customer categories, refused-feature categories, and amendment rules above are the binding Charter commitments and are unchanged.

## Change log

- **v1.3 (2026-05-27):** Substantive amendment. Added a Scope section establishing a binding boundary on what AILedger builds: it operates at the audit layer — detection and reporting — and will not propose, recommend, or implement remediation for the behavior it detects. This is a new structural commitment that constrains future product direction, in the same class as the refused-customer and refused-feature categories — not a clarification of existing text. Detection-standard citations reconciled to the maintained list in [STANDARDS.md](./STANDARDS.md). The detect-report-remediate continuum framing originated from a question posed by an advisor.
- **v1.2 (2026-05-20):** Added Regulatory context section reflecting the May 7, 2026 Digital Omnibus political agreement. Non-substantive update; no principle changes.
- **v1.1 (2026-05-18):** Jake-authored rewrite. Restructured into Purpose / Working as intended / Failure mode / Customers we refuse / Features we won't build / Decisions requiring board review / Exit conditions / Public commitment / Review cadence.
