# ADR-0010: LLM providers for PRYSM's own AI features, and data-use requirements

Status: Proposed · 2026-09-24

## Context
PRYSM's own AI features (obligation extraction, mapping proposals, LLM judges) send customer policy documents and, for judges, gateway payloads to an LLM. The owner chose Google Gemini (hosted) and Ollama (local). Customers must be able to trust that this data is never used to train a provider's models.

## Findings (checked 2026-09-24)
Gemini API Additional Terms, "Last modified: March 23, 2026" ([ai.google.dev/gemini-api/terms](https://ai.google.dev/gemini-api/terms)):
- **Unpaid Services** (free tier, AI Studio without billing): Google uses submitted content and responses "to provide, improve, and develop Google products and services", including machine learning, and **human reviewers may read** inputs and outputs. In the EEA, Switzerland and the UK, the paid-service data terms apply to unpaid use as well.
- **Paid Services**: "Google doesn't use your prompts or responses to improve our products." Prompts and responses are logged "for a limited period of time, solely for detecting and preventing violations" of the Prohibited Use Policy. The Data Processing Addendum applies.
- A project counts as Paid when it uses the API through a Cloud project with an **active billing account**.
- **Vertex AI:** the data-governance page could not be retrieved in a usable form during this check. Vertex's terms are **unverified**, and the Vertex adapter is blocked until they are checked and recorded here.

## Decision
1. **Hard requirement (principle-level): PRYSM only sends customer data to an LLM tier that contractually excludes training on that data.** For Gemini that means the **paid Gemini API** (billing-enabled Cloud project) or **Vertex AI** once verified. The unpaid tier is never allowed, in any region.
2. **Enforcement:**
   - A provider registry in config records each provider credential with `data_use_tier` (`paid_no_training` | `local`), the terms URL, the terms "last modified" date, and the date PRYSM verified it. The ai-service refuses to start with an external provider that lacks a `paid_no_training` attestation.
   - **Tenant-supplied (BYO) Gemini keys** need an explicit attestation by a tenant Owner that the key belongs to a billing-enabled project. The attestation goes into the AuditLog and evidence. The console shows the data-use tier on every AI feature.
   - A **terms review runbook** re-checks provider terms quarterly, and before any provider is added or changed. A change in the terms' "last modified" date blocks external calls for that provider until someone re-attests.
3. **Providers:** one adapter interface. The initial implementations are **Gemini API (paid)** and an **OpenAI-compatible local endpoint** (Ollama, vLLM). Vertex AI follows once verified. The provider is selected per tenant. **Self-hosted defaults to local only.** LLM-off mode stays supported (ARCHITECTURE §8).
4. **Disclosure:** the provider's limited-period abuse-monitoring logging is a data flow to a sub-processor. It's listed in the sub-processor list and the tenant's AI settings page, together with the tenant's option to choose local-only.
5. Every call is logged (provider, model, template id@version, input hash, output, tier) as an evidence record, as before.

## Consequences
- Free-tier experimentation with PRYSM's AI features isn't possible. Development uses local Ollama, or a billing-enabled dev project whose inputs are synthetic data only.
- The registry and attestation are an operational process, not a technical guarantee: a key can't reveal whether its project has billing. We mitigate that with attestations, the audit trail, and the quarterly review.

## Alternatives
- **Allow the unpaid tier for non-customer data:** it's too easy for customer data to end up flowing through it anyway. Rejected.
- **Local models only:** the safest option, but extraction quality on long regulatory PDFs would likely be lower. It stays available per tenant.
