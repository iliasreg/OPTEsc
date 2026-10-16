# OPTEsc simulation method

What the fire, evacuation and earthquake models compute, where every number comes from, how the
models were checked, and what they cannot tell you. OPTEsc is a decision-support and training tool.
It does not replace a fire safety engineer's assessment or a structural assessment, and its results
are not a certificate of compliance.

## 1. Fire and smoke: two-zone model (`frontend/src/firemodel.js`)

Each room has a hot smoke layer under the ceiling over cool air, the approach of zone models such as
CFAST.

| Item | Value or equation | Source |
|---|---|---|
| Design fire | Q = α t², α = 0.0469 kW/s² (fast), 0.188 for storage stacked 3–5 m | C/VM2 Table 2.1 |
| Peak heat release | 20 MW; 250 kW/m² sets the fire area in a zone model | C/VM2 Table 2.1 |
| Yields, pre-flashover | soot 0.07, CO 0.04, CO₂ 1.5 kg/kg; ΔHc 20 MJ/kg; radiative fraction 0.35 | C/VM2 Table 2.1 |
| Yields, post-flashover | soot 0.14, CO 0.40 kg/kg | C/VM2 2.3.2 |
| Flashover | upper layer at 500 °C; then ventilation-limited, Q = 1500 A√H kW | C/VM2 2.3.2; Kawagoe |
| Sprinkler-controlled fire | heat release held constant once the first sprinkler opens | C/VM2 2.3.1, 2.3.3 |
| Plume | Heskestad: ṁ = 0.071 Qc^(1/3) z^(5/3) + 0.0018 Qc above the mean flame height | SFPE Handbook |
| Ceiling jet | Alpert (1972) temperature and velocity correlations | SFPE Handbook |
| Smoke detectors | optical density 0.097 /m at 7 m from the fire, carried by the ceiling jet | C/VM2 Table 3.2 |
| Heat detectors | RTI 30 m½s½, 57 °C, 4.2 m | C/VM2 Table 3.2 |
| Sprinklers | quick response RTI 50, C 0.65; standard RTI 135, C 0.85; 68 °C, 3.25 m | C/VM2 Table 3.2 |
| Notification | 30 s after detection | C/VM2 3.2.2 |
| Vent flow | orifice flow of the layer over a door soffit (2.0 m), discharge coefficient 0.7 | standard zone-model vent flow |
| Heat to walls | 70% of the convective heat; 90% once sprinklers spray | assumption, usual range 60–90% |

Rooms are the zones read from the plan. Inside doors are either all open or all closed, and exit
doors stay closed.

**Not modelled:** entrainment in spill plumes, leakage, mixing at vents, smoke control systems,
fire spread beyond the room of origin, and the layer cooling after control.

## 2. Tenability and doses

Conditions are judged 2.0 m above the floor, the NZBC C4.3 criteria used by C/VM2:

- **Visibility:** at least 10 m, or 5 m in rooms under 100 m². Visibility = 3 / (8700 m²/kg × soot
  density), for light-reflecting signs.
- **Toxic dose:** FED for CO no more than 0.3. FED_CO = Σ CO(ppm) × Δt(min) / 35 000, with the CO₂
  hyperventilation factor exp(0.1903 %CO₂ + 2.0004) / 7.1 (ISO 13571).
- **Heat dose:** FED for convected heat no more than 0.3. Tolerance time is 5×10⁷ T^−3.4 minutes,
  with T in °C (ISO 13571).
- **Radiant heat:** the layer overhead must give no more than 2.5 kW/m² (Engineers Australia
  practice note, IMO MSC.1/Circ.1552).

ASET for a room is the first moment any of these criteria is exceeded. A person is incapacitated at a
full dose (FED 1, the median) or in a flashover.

## 3. People and movement (`frontend/src/sim.js`)

| Item | Value | Source |
|---|---|---|
| Pre-travel time | by building use, in or away from the room of origin; a voice alarm shortens it where the table gives a value | C/VM2 Table 3.3 |
| Spread between people | lognormal around the C/VM2 value, σ = 0.3 | assumption; lognormal shape after published drill data |
| Cue | anyone whose room has smoke below 2 m, or who is near the fire, leaves at once | |
| Adults' free speed | normal, mean 1.2 m/s, sd 0.2, cut to 0.8–1.6 | C/VM2 design speed 1.2 m/s |
| Speed and density | S = k (1 − a D), k 1.4, a 0.266, taken at most at 1.9 p/m² (queues are set by doors) | C/VM2 eq. 3.2 (SFPE) |
| Door flow | 1.32 p/s per metre of effective width (width − 2 × 0.15 m), at most 50/min per self-closing leaf | C/VM2 eq. 3.4, Table 3.5 |
| Walking aids, wheelchairs | 0.5–0.95 and 0.6–0.9 m/s; wheelchairs need 0.75 m doors, take 2.5 places at a door, no stairs | Boyce, Shields & Silcock (1999) |
| Older people | 0.8–1.2 m/s, react 1.3× later | Bohannon (1997); reaction factor is an assumption |
| Speed in smoke | falls with the extinction coefficient to about 0.3 m/s at 0.5 /m | Jin, irritant smoke |
| Radiant heat from the flames | painful past 2.5 kW/m² (point source); people go round it where they can | |
| Route choice | familiar occupants take the nearest exit. In unfamiliar buildings without a voice alarm, half head for the main entrance (widest exit) until blocked or smoked out | C/VM2 3.2.7 |

## 4. Safety check (many runs)

`assess()` runs the same emergency 20 times with different people: where they stand, their speed,
their reaction time, their profile, and, for an earthquake, the damage.

- **ASET per room:** from the fire model. It is the same in every run for a given fire.
- **RSET per room:** the last moment anyone is in that room on their way out, which covers escape
  routes as well as the room of origin.
- **Pass criterion:** a room passes when ASET exceeds the 95th-percentile RSET. The building passes
  when every room passes and no more than 5% of runs leave someone hurt or inside.

The check also reports who did not get out, why, and which doors are too narrow for a wheelchair.

## 5. Earthquake (`frontend/src/quake.js`)

The building damage state comes from the HAZUS Earthquake Model Technical Manual (FEMA, Hazus 6.1).

- **Fragility:** equivalent-PGA fragility curves give medians by structure type and design level for
  Slight, Moderate, Extensive and Complete damage, with β 0.64 (Tables 5-37 to 5-40). The reference
  spectrum is a large western-US event on soil; HAZUS gives conversions for other spectra, which are
  not applied here.
- **Collapse:** the probability of collapse given Complete damage comes from Table 12-8.
- **Casualties:** indoor casualty rates by severity 1–4 come from Tables 12-3 to 12-7. The totals per
  run are those of HAZUS.
- **Who is hurt (assumption):** people are picked by relative exposure. Under falling rubble the
  weight is 5×, sheltering under a table 0.3×, moving during the shaking 2×.
- **On the plan (illustrative):** which walls fall, how far rubble spreads, and which doors jam
  depict the damage state; HAZUS gives building-level damage, not wall-level damage. Tall slender
  furniture topples with a median of 0.3 g (assumption, in line with FEMA E-74 guidance that
  unanchored tall furniture is a leading cause of injury).
- **Behaviour:** 65% take cover until the shaking stops, the rest leave at once (assumption).
  Wheelchair users stay put.

## 6. Verification and validation (`tests/`)

| Check | Result |
|---|---|
| Corridor: 40 m at 1.33 m/s | 26–34 s (`verification.test.mjs` V1, RiMEA-style) |
| Speed–density | matches S = 1.4 (1 − 0.266 D) / 1.2 (V2) |
| Pre-movement | nobody leaves early; everyone within 0.5 s of their time (V3) |
| Corners | no wall crossing, everyone out (V4) |
| Speed distribution | mean 1.2 ± 0.03, sd 0.15–0.21 (V5) |
| Door flow, 1 m and 2 m | within 12% of C/VM2 eq. 3.4 (V6, `sim.test.mjs`) |
| 4 exits against 2 | evacuation time ratio 1.6–2.4 (V7) |
| Route choice | public crowds the main entrance; a voice alarm restores the nearest-exit split (V8) |
| Plume and ceiling jet | equal to hand calculations (`firemodel.test.mjs`) |
| Smoke layer against NFPA 92 (t² fires) | 0.2 H lower at most (conservative) and 0.05 H higher at most, for 0.5 ≤ z/H ≤ 0.9; earlier than the correlation's first filling |
| Detection order | smoke detectors before heat detectors; sprinklers hold the fire and prevent flashover |
| Doors | closed doors confine smoke; the room of origin goes first |
| ISO 13571 doses | 35 000 ppm·min equals FED 1; convective tolerance time matches |
| HAZUS damage states | frequencies within 7% of the fragility curves over 400 draws (`quake.test.mjs`) |
| HAZUS casualties | severity 1 and 2 averages within 20% of the rates |

These checks cover the code's behaviour against references and simple cases. They are not a
validation against full-scale fire tests or recorded evacuations of a specific building.

## 7. Limits to keep in mind

- **One floor at a time.** Stairs are either an exit (an upper floor) or an obstacle. Stair descent
  and floor-to-floor smoke spread are not modelled.
- **Plan-derived geometry.** Wall reading, door widths and room areas come from the drawing and need
  checking. A door measured narrower than it is will wrongly stop wheelchairs.
- **One design fire per run.** The fire location is chosen by the user ("Find worst fire" tries each
  room). Fuel load, compartmentation ratings and smoke control are not inputs.
- **Earthquake inputs.** Shaking is a peak ground acceleration, not a site-specific spectrum. HAZUS
  medians are for US building classes and need care for European construction.
- **Assumptions.** Section headings above flag them. They are the first things to vary in a
  sensitivity study.
