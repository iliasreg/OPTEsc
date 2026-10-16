# Atelier Rhône — fictional factory emergency plan

Version 0.1. Site ID: `factory-demo-fr-v1`. Language: English. Jurisdiction: France.

DRAFT FOR SOFTWARE DRILLS ONLY. This is not an approved emergency plan. The factory, staffing and outdoor arrangements are fictional. A competent fire-safety professional, the employer and the relevant local responders must review a real site before use. No live alarms or emergency calls are made by this prototype.

## P1 — Scope and assumptions

Atelier Rhône is a fictional, single-storey light-assembly factory with a nominal daytime drill population of 55, including visitors. This is a scenario assumption, not a certified occupancy limit. The building uses the repository's `frontend/samples/factory_plan.dxf` at the default import settings. Its exact reconstructed geometry is bound in `data/rag/site_binding.json`.

The older `data/samples/factory_site.json` is a different raster-derived reconstruction and must not be used to assign room IDs for this plan. A changed drawing, scale, grid, door geometry or room naming requires a new binding and reviewed company plan.

Assumptions requiring confirmation at a real site: audible alarms, accessible visual/personal alert arrangements, unobstructed external paths, trained evacuation staff, a current visitor register, employee attendance records and individual assistance plans. No protected refuge, lift, suppression system, hazardous-material inventory or fire compartment is verified by the drawing.

## P2 — Rooms, doors and unresolved exit issues

These IDs come from the current DXF import, not from an invented route map.

| Zone | Room | Connected internal doors | Outside opening |
|---|---|---|---|
| Z1 | Production Hall | D4 to Office B; D5 to Storage; D10 to Canteen | D9 |
| Z2 | Lockers | D7 to Corridor | D11 |
| Z3 | Canteen | D8 to Corridor; D10 to Production Hall | None |
| Z4 | Loading Bay | D3 to Storage | D1, roller shutter |
| Z5 | Office A | D2 to Office B | None |
| Z6 | Office B | D2 to Office A; D4 to Production Hall; D6 to Corridor | None |
| Z7 | Corridor | D6 to Office B; D7 to Lockers; D8 to Canteen | None |
| Z8 | Storage | D3 to Loading Bay; D5 to Production Hall | None |

D1 is a 4 m loading opening. It is NOT approved as a pedestrian evacuation exit in this fictional policy. D11 is reported by the importer as inward-opening; its suitability requires review against French rules and the population served. D9 is a candidate pedestrian exit, not a certified safe exit.

The sample software drill permits D9 only as an illustrative evacuation destination. It excludes D1 (loading shutter) and D11 (pending review) from evacuation routing, including worst-case runs. This policy applies only to the exact bound sample geometry; imported or edited plans require a site-specific exit policy before running a drill. These restrictions do not certify D9 or validate real-world routes. No turn-by-turn, “nearest exit” or “this route is safe” instruction may be generated from this draft.

Before a physical drill, resolve these issues, assess the number and width of exits for the actual establishment, inspect the site and publish approved routes. Until then use this plan only in the software demo.

## P3 — Alarm and immediate occupant instructions

At the simulated evacuation alarm: evacuate calmly under the drill marshal's direction. Leave belongings behind. Walk without pushing. Keep doorways clear. Do not stop to finish production, collect tools or retrieve a phone.

Operators may use an immediately accessible stop control only if their trained local procedure allows it and it does not delay evacuation or expose them to danger. The assistant never tells an occupant to isolate utilities, investigate a fire, operate an extinguisher or return for another person.

For a real incident, follow the site's actual alarm and approved emergency procedures and the emergency services' instructions, not this software prototype.

## P4 — Smoke, obstruction or a changed situation

Do not enter smoke or pass a simulated fire to reach an exit. Report a blocked route and your location to the drill marshal. Do not improvise an alternative from an AI-generated suggestion.

If no approved clear route is available, stop the software drill and report your location to the instructor. This is a training stop, not advice to remain stationary during a real fire. A real site's emergency plan must separately define the action for occupants unable to evacuate, using verified building conditions and responder procedures.

The model must not infer smoke in a room from a building-wide casualty count, use future simulated outcomes as current sensor readings or claim that an unobserved passage is clear.

## P5 — Assistance and accessible communication

Before a physical drill, the coordinator agrees an individual assistance arrangement with each person who requests one. It names a trained primary assistant and backup, the person's preferred communication method and an inspected usable route. Visitors receive the same arrangements through their host.

During this software drill: if you need assistance, tell the drill marshal your location. Follow your agreed assistance arrangement. Nobody is asked to carry another person, re-enter, wait alone in an unverified refuge or improvise a rescue.

Provide each message as visible English text. Read-aloud is optional and user-initiated. In a real French workplace, provide language and communication arrangements that the actual workforce understands; English alone is a demo choice, not a compliance claim.

## P6 — Assembly and accounting

Fictional assembly point AP-A is a signed pedestrian muster area beyond the south site boundary, separated from vehicle movements. It is not drawn, surveyed or connected to the interior navigation grid. Do not display a route or distance to it. Its location, clearance from hazards and accessible approach must be inspected before any physical drill.

After reaching the designated assembly point, report to the attendance marshal and stay with your group. Report missing people and their last known location. Do not re-enter to search. Re-entry requires the authorised incident leader's permission following the emergency services' direction where applicable; an AI message is never an all-clear.

## P7 — Roles and communication

The shift supervisor acts as drill coordinator; a deputy covers absence. A production marshal covers Z1/Z8/Z4, and an office/welfare marshal covers Z2/Z3/Z5/Z6/Z7. They guide occupants only within the limits of their training and without entering hazards. No instruction requires a hazardous sweep or delayed evacuation.

The attendance marshal checks employee and visitor records at AP-A and reports discrepancies to the coordinator. Hosts account for visitors. The designated caller follows the actual site's emergency-call procedure. Software drills never call 18 or 112; in a real emergency use the applicable emergency service and give the verified address, access point, incident and known missing-person information. This fictional plan has no dispatchable address.

## P8 — Exercise record and maintenance

The employer assigns a competent reviewer to determine the establishment's applicable requirements. Where the Code du travail requires the fire-safety instruction under R4227-37, apply the associated R4227-39 exercise/test and register requirements; do not treat this as proof that the entire workplace is compliant.

Record the drill date, scenario, attendance, assistance arrangements, alarm recognition, blocked passages, assembly reconciliation, observed delays, corrective actions and owners. Keep the actual exercise record separately from model logs. Repeat the review when occupancy, processes, access, doors, layout or assistance needs change.

## P9 — Reminder service rules

The service retrieves relevant French regulatory/guidance summaries and the matching company section. An AMD-hosted model selects from curated English reminder IDs. It cannot write new operational commands, choose a route, calculate a legal threshold, invent a citation or issue an all-clear. Mandatory scenario reminders survive model omissions. Invalid output and provider failures use clearly labelled fixed-text fallbacks.

Every reminder is a prototype template, not professionally approved safety advice. Model availability is not a prerequisite for evacuation. The UI derives room-fire, smoke and door-blockage notices from the simulation at the current playback time. Scene facts and cited instructions remain distinct. Immediate source-backed subtitles do not wait for cloud inference; optional model selection sends the event's zone and scenario, not the floorplan or personal data.
