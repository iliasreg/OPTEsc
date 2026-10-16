# French fire-safety reference register

This is a limited prototype corpus, not a legal compliance assessment. The English summaries are unofficial. French law governs this example; the application speaks English by request. Neither the Ministry nor INRS endorses OPTEsc.

## Sources and provenance

Article texts were read from the Ministry of Labour's Code du travail numérique. Direct Légifrance access encountered an anti-bot challenge; do not describe it as a successful full-text fetch. For authoritative interpretation and the current consolidated legal position, check Légifrance and obtain competent review. Source content, fetch date and SHA-256 evidence hashes appear in `data/rag/sources.json`; retrieval summaries appear in `chunks.json`.

| Reference | Type | Scope in this prototype |
|---|---|---|
| [R4227-4](https://code.travail.gouv.fr/code-du-travail/r4227-4) | Law, use of workplaces | Escape passages must remain clear; material must not obstruct movement or reduce required widths. |
| [R4227-5](https://code.travail.gouv.fr/code-du-travail/r4227-5) | Law, use of workplaces | Minimum exit counts and aggregate widths depend on the population; each regulatory passage must be at least 0.80 m. The table gives 1/0.80 m below 20 people, 1/1.50 m for 20–100, 2/2 m for 101–300, and 2/2.50 m for 301–500. This is not a complete design specification. |
| [R4227-6](https://code.travail.gouv.fr/code-du-travail/r4227-6) | Law, use of workplaces | Doors potentially used to evacuate more than 50 people open in the exit direction. Regulatory escape doors open by a simple operation; locked doors must be operable from inside without a key. |
| [R4227-34](https://code.travail.gouv.fr/code-du-travail/r4227-34) | Law | Establishments normally accommodating more than 50 people, and those handling the listed flammables irrespective of size, require an audible alarm. |
| [R4227-37](https://code.travail.gouv.fr/code-du-travail/r4227-37) | Law | Fire instructions and posting requirements depend on establishment category. Other establishments still need evacuation instructions. Read the displayed transitional note when establishing applicability. |
| [R4227-38](https://code.travail.gouv.fr/code-du-travail/r4227-38) | Law | Instructions specify evacuation leaders, disability measures, alert means, designated callers and emergency contact information, among other duties. This prototype does not implement the article's firefighting/first-intervention training requirements. |
| [R4227-39](https://code.travail.gouv.fr/code-du-travail/r4227-39) | Law | Applicable fire instructions provide periodic tests and exercises at least every six months, with dates and observations recorded for labour inspection. Do not equate a simulated run with a physical exercise or a complete statutory record. |
| [R4216-11](https://code.travail.gouv.fr/code-du-travail/r4216-11) | Law, construction provisions | At most 40 m to reach stairs on upper/basement floors; stair discharge at ground level less than 20 m from an outside exit; dead ends at most 10 m. These are NOT a universal ground-floor distance-to-exit rule. |
| [INRS — Incendie sur le lieu de travail : Évacuation, intervention et consignes de sécurité](https://www.inrs.fr/risques/incendie-lieu-travail/evacuation-intervention-consignes-securite.html) | Prevention guidance, not legislation | Prompt organised evacuation, adapted roles, assembly accounting and site-specific instructions. |

## Measurements and applicability

The sample's nominal 55-person population is a fictional assumption. Before applying any table, establish the relevant legal regime, actual population and distribution, construction date, activities, mobility needs and whether other rules apply (for example ERP or ICPE requirements). The R4216 construction provisions must not be collapsed into the R4227 workplace-use table.

The existing application still contains UK/NFPA checks and a default 45 m travel-distance indicator. They are not French compliance results. This RAG addition does not replace that analyser, certify its geometry or approve the simulator's exits. D1 is a shutter and D11's inward swing is unresolved; the fictional plan deliberately provides no generated route instructions.

Legal numeric measurements are stored as reference chunks for traceability, not selected as occupant reminders. The model cannot calculate a new threshold or turn a planning recommendation into an emergency command.

## Rights and maintenance

The corpus contains original English factual summaries and links. It does not bundle INRS PDFs, illustrations or page copies. [INRS reuse terms](https://www.inrs.fr/footer/mentions-legales.html) restrict reproduction beyond private use and permit links; obtain permission before distributing INRS source material or a fuller derived corpus. Referenced guidance is not an INRS licence grant.

The summaries are a curated snapshot, not a live legal feed. Before deployment, recheck source versions, changes in law and applicability with qualified personnel. Review the company plan and action templates together; changing a source alone must not silently change a safety instruction.

## Earthquake guidance

[Préfecture des Hautes-Alpes — Les consignes individuelles de sécurité](https://www.hautes-alpes.gouv.fr/Actions-de-l-Etat/Environnement-bruit-risques-naturels-et-technologiques/Risques-naturels-et-technologiques/Dossier-Departemental-des-Risques-Majeurs-DDRM/Les-risques-naturels/Seisme/Les-consignes-individuelles-de-securite), updated 24 November 2020; retrieved 2026-10-16T19:55:18.588860+00:00. Official public safety guidance, not legislation or an approved factory plan. The corpus contains original English summaries of the Pendant and Après sections. The SHA-256 of the retrieved DOM text and source URL are recorded in data/rag/sources.json.

During shaking: stay where you are, protect your head, use sturdy cover, avoid windows; outside, avoid power lines and falling structures. Afterwards: expect aftershocks, avoid lifts and things that may collapse, follow official instructions. We omit utility-isolation tasks and do not approve any rubble crossing or re-entry. Site-specific conditions still require competent review.

The Sécurité civile website blocked retrieval; it is not used as evidence. The Géorisques landing page was readable, but its poster instructions were not extracted, so it is not an action citation.
