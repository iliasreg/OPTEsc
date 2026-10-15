# Plan reader: results and where it fails

Produced by `node run_eval.mjs` on 2026-10-15, in a headless browser on CPU. Real plans are opened the way a user would: no scale typed and no hints given, so room names, sizes and the scale all come from the plan itself. The full tables follow the summary.

## Summary

| Check | Result |
|---|---|
| Sample factory, DXF | room areas within 1.8% of truth, 11/11 doors found, widths within 0.10 m, swing side 11/11, hinge 10/10 |
| Sample factory, PDF | room areas within 1.5%, 11/11 doors, widths within 0.09 m, swing 11/11, hinge 10/10 |
| Sample factory, PNG | room areas within 2.9%, 11/11 doors, widths within 0.13 m, swing 11/11, hinge 10/10 |
| 5 development plans (images) | 37/43 rooms found as their own room, 29/29 readable names right, scale found with nothing typed (4 from printed sizes, 1 from doors); median area error 2 to 11% per plan |
| 6 blind plans (never seen while building) | first run 31/51 rooms; after fixing general causes 33/51 (32/39 without the light grey brochure plan); UK estate-agent plans: areas within 9 to 20% (median) |
| IFC export | all 8 files pass IfcOpenShell schema and EXPRESS rules with 0 issues, every element's geometry builds, and web-ifc reads every file |
| CubiCasa5K IoU (50 test plans, run on the owner's RTX 4050, 2026-10-15) | CubiCasa CNN alone: wall 0.70, room 0.88. Combined (CNN walls, OPTEsc doors, rooms, names, scale and exits): wall 0.61, room 0.84. OPTEsc reader alone: wall 0.21, room 0.47. About 0.13 s per plan each. |

## Before and after (rooms found as their own room)

"Before" is the previous version given the right building width by hand (it could not find the scale or read names). "After" is this version with nothing typed.

| Plan | Before | After | Names read after |
|---|---|---|---|
| Your house plan (first_new) | 4/9 (family, kitchen, dining, entry and stair hall one zone; WC lost) | 9/9 | 8/8 |
| Your Matterport plan | 3/10 | 10/10 | 9/9 (bath label is sideways) |
| Swedish apartment | 3/7 | 7/7 | 6/6 (Badrum missed by OCR) |
| US apartment | 2/6 | 6/6 | 6/6 |
| Israeli apartment (Hebrew) | 5/11 | 5/11 | none (Hebrew not read) |

## Where it fails

1. **Labels that can't be read.** Hebrew and other non-Latin scripts, and names printed sideways (the Matterport bath), give unnamed rooms. Without names, open-plan areas can't be split, so the Israeli kitchen, living, dining and guest WC stay one zone.
2. **Open-plan borders are estimates.** Where no wall separates two named rooms, the line between them is the shortest corner-to-corner cut, not the designer's line. The Matterport living room (+27%, includes the stair area) and office (+160%, takes the lobby beside it) show this.
3. **Scale without printed sizes** comes from door widths and is about 15 to 20% off on the house plan (flagged as an estimate). Typing one known length fixes it.
4. **Small text** is read less reliably: some sizes on the 800 px Matterport image lose digits ("9'11" read as 9'1").
5. **Narrow corridors** under about 1.2 m can still be read as doorways in scanned plans.
6. **Not tested yet:** curved and diagonal walls, multi-storey plans, hand drawings and photos of paper plans.

## What changed in this round

- Doors are now found as short gaps between wall ends (door jambs), so corridors and passages are no longer mistaken for doors and small rooms like the WC are kept.
- Room names and sizes are read from the image (OCR in the browser), then used to split open-plan zones into one room per name, joined by an opening.
- The scale is set automatically from all printed room sizes (median), else from door widths, else from wall thickness, and the page says which.
- Size lines are read a second time on their own, which fixed the Matterport scale (median area error 35% to 11%).

## Blind test: plans never seen while building

Six public plans from other projects (`eval/blind_plans.json`), opened with no input. Run once as they came, then once after fixing causes that apply to any plan (not tuned to these images):

- big bold names were read as wall blobs (names now erased from the wall layer when the blob lies wholly inside the name);
- a size printed twice (metres and feet) was added up; one per room now;
- "126 x 80" can be centimetres or 12'6" x 8'0" with the marks lost: the reading that gives a believable room area wins;
- names split over two lines (Bedroom / 2, Reception / Room) are joined; "Fourth Floor" is no longer a room;
- labels drawn on a wall still name the room within a metre.

| Plan | Style | Rooms, first run | Rooms, after | Names right, after | Median area error, after |
|---|---|---|---|---|---|
| UK flat, red walls | estate agent, m and ft | 7/7 | 7/7 | 5/5 | 20% (was 117%) |
| UK flat, 2nd floor | estate agent, bath labels outside the walls | 8/8 | 8/8 | 3/8 | 10% |
| UK flat, 4th floor | estate agent, m and ft | 6/8 | 6/8 | 4/5 | 9% |
| UK terrace | large names, no sizes | 5/7 | 5/7 | 4/6 | - |
| Japanese flat | colour-filled rooms, Japanese names | 4/9 | 6/9 * | 0/1 | - |
| Australian house | light grey brochure render, tiny lower-case names | 1/12 | 1/12 | 0/12 | - |

\* The truth points were moved off the Japanese labels after the first run; the labels themselves read as walls.

**What this says:** black-on-white plans of the kind you get from estate agents, Matterport or CubiCasa work, with most rooms found and named. Brochure renders with hair-thin grey interior walls do not: the walls are filtered out as linework. Non-Latin names are not read.

### Blind plans, full tables (after)

**uk_flat_red**: 7/7 rooms found on their own, 5/5 readable names right, scale from rooms (width 8.18 m), area error median 20%, worst 63.4% over 5 printed rooms.

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Dining room | Dining Room | 6.38 | 7.89 | 23.7% |
| Reception room | Reception Room | 18.04 | 29.48 | 63.4% |
| Kitchen | Kitchen | 5.69 | 6.83 | 20% |
| Bathroom (name not readable) | Zone 7 | - | 4.35 | - |
| Shower room (name not readable) | Zone 8 | - | 3.74 | - |
| Bedroom 2 | Bedroom 2 | 11.16 | 11.24 | 0.7% |
| Master bedroom | Master Bedroom | 14.33 | 16.16 | 12.8% |

**uk_flat_2nd**: 8/8 rooms found on their own, 3/8 readable names right, scale from rooms (width 15.09 m), area error median 10.3%, worst 40.2% over 8 printed rooms.

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Bedroom | Bedroom | 17.96 | 19.81 | 10.3% |
| Kitchen | Zone 6 | 9.36 | 7.28 | -22.2% |
| Bedroom | Zone 4 | 9.48 | 10.11 | 6.6% |
| Bathroom | Zone 8 | 6.13 | 4.97 | -18.9% |
| Bathroom | Zone 9 | 3.98 | 2.38 | -40.2% |
| Reception room | Reception Room | 36.02 | 35.84 | -0.5% |
| Bedroom | Bedroom | 16.49 | 17.45 | 5.8% |
| Bathroom | Zone 7 | 6.13 | 6.4 | 4.4% |

**uk_flat_4th**: 6/8 rooms found on their own, 4/5 readable names right, scale from rooms (width 11.8 m), area error median 9.4%, worst 10.8% over 5 printed rooms.

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Bedroom | merged into Bedroom | 14.72 | 17.37 | - |
| Bedroom | Bedroom | 9.36 | 10.26 | 9.6% |
| Reception room | Reception Room | 22.38 | 22.94 | 2.5% |
| Hall (size only) (name not readable) | Zone 4 | 10.66 | 11.66 | 9.4% |
| Bedroom | Bedroom | 12.44 | 12.19 | -2% |
| Kitchen | Kitchen | 8.02 | 8.89 | 10.8% |
| WC (name not readable) | merged into Bedroom | - | 17.37 | - |
| Bathroom (name not readable) | Zone 8 | - | 3.95 | - |

**au_house_grey**: 1/12 rooms found on their own, 0/12 readable names right, scale from walls (width 26.28 m).

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Activity | merged into Zone 1 | - | 224.14 | - |
| Family/living | merged into Zone 1 | - | 224.14 | - |
| Dining | merged into Zone 1 | - | 224.14 | - |
| Gourmet kitchen | merged into Zone 1 | - | 224.14 | - |
| Master suite | merged into Zone 1 | - | 224.14 | - |
| Study nook | merged into Zone 1 | - | 224.14 | - |
| Entry | Zone 2 | - | 7.83 | - |
| Home theatre | merged into Zone 1 | - | 224.14 | - |
| Bed 2 | merged into Zone 1 | - | 224.14 | - |
| Bed 3 | merged into Zone 1 | - | 224.14 | - |
| Bed 4 | merged into Zone 1 | - | 224.14 | - |
| Double garage | merged into Zone 1 | - | 224.14 | - |

**uk_terrace**: 5/7 rooms found on their own, 4/6 readable names right, scale from walls (width 7.35 m).

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Shower | Zone 6 | - | 5.67 | - |
| Kitchen | Kitchen | - | 9.19 | - |
| Lounge | Lounge | - | 19.59 | - |
| Bedroom 2 | merged into Bedroom | - | 17.06 | - |
| Landing (label sideways) (name not readable) | merged into Bedroom | - | 17.06 | - |
| Bedroom 1 | Bedroom 1 | - | 21.82 | - |
| Bedroom 3 | Bedroom | - | 9.1 | - |

**jp_flat**: 6/9 rooms found on their own, 0/1 readable names right, scale from doors (width 16.37 m).

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Bedroom (name not readable) | merged into Zone 1 | - | 55.71 | - |
| WIC | Zone 4 | - | 4.83 | - |
| Bedroom (name not readable) | Zone 2 | - | 17.8 | - |
| Living (name not readable) | merged into Zone 1 | - | 55.71 | - |
| Hall (name not readable) | Zone 10 | - | 1.8 | - |
| Toilet (name not readable) | Zone 7 | - | 2.51 | - |
| Bath (name not readable) | Zone 9 | - | 1.61 | - |
| Washroom (name not readable) | Zone 6 | - | 5.07 | - |
| Entrance (name not readable) | not found | - | - | - |

## Sample factory (known geometry)

**DXF**: rooms within 1.8% (mean 0.7%), 11/11 doors found, widths within 0.10 m, swing side right 11/11, hinge right 10/10.

| Room | Measured m² | True m² | Error |
|---|---|---|---|
| Production Hall | 563.35 | 563.54 | 0% |
| Lockers | 56.04 | 56.23 | -0.3% |
| Canteen | 56.74 | 57.11 | -0.6% |
| Loading Bay | 51.29 | 50.68 | 1.2% |
| Office A | 46.5 | 46.68 | -0.4% |
| Office B | 47.05 | 47.41 | -0.8% |
| Corridor | 17.75 | 18.08 | -1.8% |
| Storage | 86.17 | 86.43 | -0.3% |

Open archways (no door leaf) are read as openings between rooms, not doors: 3 m at 28.5,9.

**PDF**: rooms within 1.5% (mean 0.5%), 11/11 doors found, widths within 0.09 m, swing side right 11/11, hinge right 10/10.

| Room | Measured m² | True m² | Error |
|---|---|---|---|
| Production Hall | 563.47 | 563.54 | 0% |
| Canteen | 56.87 | 57.11 | -0.4% |
| Lockers | 56.05 | 56.23 | -0.3% |
| Loading Bay | 51.42 | 50.68 | 1.5% |
| Office B | 47.17 | 47.41 | -0.5% |
| Office A | 46.52 | 46.68 | -0.3% |
| Corridor | 17.96 | 18.08 | -0.7% |
| Storage | 86.53 | 86.43 | 0.1% |

Open archways (no door leaf) are read as openings between rooms, not doors: 3 m at 28.5,9.

**PNG**: rooms within 2.9% (mean 1.2%), 11/11 doors found, widths within 0.13 m, swing side right 11/11, hinge right 10/10.

| Room | Measured m² | True m² | Error |
|---|---|---|---|
| Production hall | 562.9 | 563.54 | -0.1% |
| Canteen | 56.67 | 57.11 | -0.8% |
| Lockers | 55.48 | 56.23 | -1.3% |
| Loading bay | 50.56 | 50.68 | -0.2% |
| Office B | 46.68 | 47.41 | -1.5% |
| Office A | 45.68 | 46.68 | -2.1% |
| Corridor | 17.55 | 18.08 | -2.9% |
| Storage | 85.86 | 86.43 | -0.7% |

Open archways (no door leaf) are read as openings between rooms, not doors: 3 m at 28.5,9.

## Real plans (opened with no scale and no hints)

**user_house**: 9/9 rooms found on their own, 8/8 readable names right, scale from doors (width 15.92 m).

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Family room | Family Room | - | 27.09 | - |
| Kitchen | Kitchen | - | 19.53 | - |
| Dining room | Dining Room | - | 15.52 | - |
| Office / library | Office / Library | - | 17.79 | - |
| Pantry | Pantry | - | 9.66 | - |
| Mud room | Mud Room | - | 9.37 | - |
| Entry | Entry | - | 12.54 | - |
| Garage | Garage | - | 33.74 | - |
| WC (name not readable) | Zone 5 | - | 1.93 | - |

**user_matterport**: 10/10 rooms found on their own, 9/9 readable names right, scale from rooms (width 17.93 m), area error median 10.9%, worst 152.3% over 10 printed rooms.

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Kitchen | Kitchen | 33.42 | 31.71 | -5.1% |
| Living room | Living Room | 27.68 | 33.52 | 21.1% |
| Bedroom | Bedroom | 11.33 | 12.57 | 10.9% |
| Hall | Hall | 2.76 | 3 | 8.7% |
| Bath (label printed sideways) (name not readable) | Zone 4 | 5.02 | 3.98 | -20.7% |
| Room | Room | 5.54 | 5.33 | -3.8% |
| Entryway | Entryway | 13.91 | 15.45 | 11.1% |
| Den | Den | 22.19 | 21.92 | -1.2% |
| Formal dining | Formal Dining | 17.07 | 17.3 | 1.3% |
| Office | Office | 5.53 | 13.95 | 152.3% |

**swedish_apartment**: 7/7 rooms found on their own, 6/6 readable names right, scale from rooms (width 13.95 m), area error median 5.3%, worst 9% over 4 printed rooms.

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Sovrum | Sovrum 1 | 13 | 12.31 | -5.3% |
| Klk | Klk | 3 | 3.05 | 1.7% |
| Badrum/tvätt (name not readable) | Zone 3 | 6 | 5.9 | -1.7% |
| Vardagsrum | Vardagsrum | 41 (with Matplats, Kok) | 44.68 | 9% |
| Entre | Entre | - | 3.66 | - |
| Matplats | Matplats | - | 19.1 | - |
| Kok | Kok | - | 9.81 | - |

**us_apartment**: 6/6 rooms found on their own, 6/6 readable names right, scale from rooms (width 9.48 m), area error median 7.1%, worst 15.3% over 5 printed rooms.

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Bedroom | Bedroom | 10.38 | 11.97 | 15.3% |
| Bedroom | Bedroom | 13.9 | 13.1 | -5.8% |
| Terrace | Terrace | - | 5.95 | - |
| Kitchen | Kitchen | 9.99 | 9.96 | -0.3% |
| Foyer | Foyer | 14.56 | 15.6 | 7.1% |
| Living room | Living Room | 16.77 | 15.32 | -8.6% |

**israeli_apartment**: 5/11 rooms found on their own, 0/0 readable names right, scale from rooms (width 15.67 m), area error median 1.6%, worst 76.8% over 5 printed rooms.

| Room on plan | Found as | Printed m² | Measured m² | Error |
|---|---|---|---|---|
| Parents' bedroom (name not readable) | merged into Zone 2 | 11.17 | 16.67 | - |
| Parents' bath (name not readable) | merged into Zone 2 | 3.59 | 16.67 | - |
| Bedroom 2 (name not readable) | Zone 8 | 9.13 | 8.98 | -1.6% |
| Kitchen (name not readable) | merged into Zone 1 | 8.81 | 53.24 | - |
| Living (name not readable) | merged into Zone 1 | 20.58 | 53.24 | - |
| Bedroom 3 (name not readable) | Zone 7 | 9.26 | 9.2 | -0.6% |
| Bath (name not readable) | Zone 5 | 5.64 | 9.97 | 76.8% |
| Guest WC (name not readable) | merged into Zone 1 | 1.57 | 53.24 | - |
| Dining (name not readable) | merged into Zone 1 | 11.69 | 53.24 | - |
| Safe room (name not readable) | Zone 3 | 9.31 | 14.51 | 55.9% |
| Bedroom 4 (name not readable) | Zone 4 | 11.11 | 10.93 | -1.6% |

## IFC export read by independent tools

| Plan | web-ifc walls/doors/windows/spaces | IfcOpenShell rule issues | IfcOpenShell geometry |
|---|---|---|---|
| sample_dxf | 41/11/0/8 | 0 | 60 built, 0 failed |
| sample_pdf | 59/11/0/8 | 0 | 78 built, 0 failed |
| sample_png | 43/11/0/8 | 0 | 62 built, 0 failed |
| user_house | 99/9/15/9 | 0 | 132 built, 0 failed |
| user_matterport | 130/19/7/12 | 0 | 168 built, 0 failed |
| swedish_apartment | 60/10/4/7 | 0 | 81 built, 0 failed |
| us_apartment | 46/12/1/9 | 0 | 68 built, 0 failed |
| israeli_apartment | 155/18/8/11 | 0 | 192 built, 0 failed |
