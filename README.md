# WME Florida Functional Classification Overlay

A Tampermonkey userscript for the [Waze Map Editor](https://www.waze.com/editor) (WME). It overlays FDOT's functional classification (FC) data for Florida and points out segments whose road type or State Road name doesn't match FDOT records.

Florida is in the Southeast Region (SER) and follows the [USA road-type standard](https://www.waze.com/discuss/t/road-types/377949). The script applies that standard's FC × highway-system table.

## Features

- **FC overlay.** FDOT functional class lines are drawn under WME segments. Each line uses the WME color of the road type its class calls for, so a mismatch is visible at a glance.

  | FDOT FC (rural / urban) | Overlay color (Locally-maintained column) |
  |---|---|
  | 01 / 11 Interstate | Freeway |
  | 02 / 12 Other Freeway/Expressway | Major Highway |
  | 04 / 14 Other Principal Arterial | Major Highway |
  | 06 / 16 Minor Arterial | Minor Highway |
  | 07 / 17 Major Collector | Primary Street |
  | 08 / 18 Minor Collector | Primary Street |
  | 09 / 19 Local | Street |

- **Under-typed segments (red dashed outline).** Each segment is matched to the nearest FDOT line that runs the same direction. The script then works out the expected type from the full USA table. It reads the highway system from the segment's primary and alternate names (`I-`, `US-`, `SR-`, `CR-`, with BUS/SPUR/LOOP handled separately).
  - A segment is not flagged when a correctly typed road runs alongside it in the same direction. This covers turn lanes, connectors and frontage roads.
  - The opposite carriageway of a divided road doesn't count as cover, so a mistyped carriageway is still flagged.
- **State Road name check (orange dotted outline).** A segment named `SR-N` is flagged when N isn't a Florida State Road number. The typical case is a county road mislabeled as a state road (`SR-420` that should be `CR-420`).
  - The 520 valid numbers are hard-coded in the script (`FL_STATE_ROADS`). They come from FDOT's State Roads layer plus Wikipedia's list of Florida state roads, captured 2026-11-04.
  - Invalid SR names are ignored for the road-type check, so a bad name shows here and not as a misleading red flag.
- **Selected-segment details.** Select a segment to see the following in the **FL FC** sidebar tab:
  - its names, highway system, current type and expected type
  - the result of the SR name check
  - the FDOT roadway ID, class, county and mileposts
- **Settings.** The **FL FC** tab has:
  - checkboxes for each class
  - an overlay opacity slider
  - a "show mismatches only" switch
  - a switch for the SR name check

  Settings are saved in `localStorage`. The overlay as a whole is turned on and off from WME's layer list (**FL Functional Class**).

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Create a new script, paste in the contents of `wme-fl-functional-class.user.js`, and save it.
3. Open WME over Florida. The script loads data at zoom 14 and closer.

The script uses `GM_xmlhttpRequest` with `@connect services1.arcgis.com` because WME's Content Security Policy blocks pages from requesting arcgis.com directly. If Tampermonkey asks for permission, choose **Always allow domain**.

## Data sources

- [Functional_Classification_TDA](https://www.arcgis.com/home/item.html?id=5c629bc81b104fca8d937343cdcefe29): FDOT TDA public feature service (RCI Feature 121, `FUNCLASS`), queried live.
- The State Road number list is a static snapshot. It combines FDOT [State_Roads_TDA](https://www.arcgis.com/home/item.html?id=d8ce6b8eee2646e6a0b534281e0391a0) with the 7 extra routes from [Wikipedia](https://en.wikipedia.org/wiki/List_of_state_roads_in_Florida). Refresh it if FDOT adds new routes.

FDOT notes that this data reflects the most recent inventory and may not match current conditions. Always confirm against signage and local guidance before editing.

## Tuning

Constants near the top of the mismatch section in the script:

| Constant | Default | Purpose |
|---|---|---|
| `MIN_ZOOM` | 14 | No data is fetched below this zoom level |
| `MATCH_DIST_M` | 20 | Maximum distance from a segment's midpoint to an FDOT FC line |
| `MATCH_ANGLE_DEG` | 30 | Maximum difference in direction for a match |
| `COVER_DIST_M` | 30 | How close a correctly typed parallel road must be to cover a segment |

The FC → road type defaults are in `FC_TO_RT`, and the full table is `USA_TABLE`.

## Known limitations

- **FC 02/12:** FDOT puts "Other Freeway" and "Other Expressway" in one code. The script uses Major Highway as the minimum, so fully controlled-access roads typed Major Highway are not flagged for being below Freeway.
- **Frontage roads:** the "at least Primary Street" rule isn't checked.
- **Promotions:** roads raised above their class for continuity are never flagged. Only roads typed lower than expected are.
- **Name formats:** names that aren't in `I-`/`US-`/`SR-`/`CR-` form are treated as locally maintained.
- **SR name check:** only `SR-`/`FL-` names are checked, and only whether the number exists in Florida. A real number on the wrong road (for example `SR-434` on SR 46) isn't caught. Letter suffixes and `SR-A1A` aren't checked.
- **Wide divided roads:** carriageways far from FDOT's single median line may fall outside the match distances.

## Built with

The [WME JavaScript SDK](https://www.waze.com/editor/sdk/) in async mode.

## License

[MIT](LICENSE). The license covers this script only. FDOT data is subject to FDOT's own terms and disclaimer.
