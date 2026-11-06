// ==UserScript==
// @name         WME Florida Functional Classification Overlay
// @namespace    https://github.com/makotosan/wme-fl-funcclass
// @version      0.5.0
// @description  Overlays FDOT functional classification on the Waze Map Editor, colored by the Waze road type each FC calls for, and flags under-typed segments.
// @author       makoto
// @license      MIT
// @match        https://www.waze.com/*editor*
// @match        https://beta.waze.com/*editor*
// @exclude      https://www.waze.com/*user/editor*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      services1.arcgis.com
// ==/UserScript==

/* global GM_xmlhttpRequest, unsafeWindow */
(function () {
  "use strict";

  const SCRIPT_ID = "wme-fl-funcclass";
  const SCRIPT_NAME = "FL Functional Class";
  const LAYER = "fl-funcclass";
  const MISMATCH_LAYER = "fl-funcclass-mismatch";
  const SR_LAYER = "fl-funcclass-srname";
  const CHECKBOX_NAME = "FL Functional Class";
  const SETTINGS_KEY = "wme-fl-funcclass-settings";
  const MIN_ZOOM = 14;
  const MAX_PAGES = 10;
  const QUERY_URL =
    "https://services1.arcgis.com/O1JpcwDW8sjYuddV/arcgis/rest/services/Functional_Classification_TDA/FeatureServer/0/query";
  // ArcGIS Map Viewer with the FDOT FC layer item added (used for "open in FDOT map" links).
  const FDOT_LAYER_ITEM = "5c629bc81b104fca8d937343cdcefe29";
  const MAPVIEWER_URL = "https://www.arcgis.com/apps/mapviewer/index.html";

  // --- Waze road types: id (SDK ROAD_TYPE), rank (higher = more important), WME color ---
  const RT = {
    FREEWAY:        { id: 3, rank: 5, color: "#C577D2", label: "Freeway" },
    MAJOR_HIGHWAY:  { id: 6, rank: 4, color: "#45B8D1", label: "Major Highway" },
    MINOR_HIGHWAY:  { id: 7, rank: 3, color: "#69BF88", label: "Minor Highway" },
    PRIMARY_STREET: { id: 2, rank: 2, color: "#F0EA72", label: "Primary Street" },
    STREET:         { id: 1, rank: 1, color: "#FFFFFF", label: "Street" },
  };
  // Segment road types we compare; everything else (ramps, private, PLR, off-road, alley, trails…) is skipped.
  const RANK_BY_ROAD_TYPE = Object.fromEntries(Object.values(RT).map((r) => [r.id, r]));

  const FC_LABELS = {
    "01": "Rural Principal Arterial - Interstate",
    "02": "Rural Principal Arterial - Freeway/Expressway",
    "04": "Rural Principal Arterial - Other",
    "06": "Rural Minor Arterial",
    "07": "Rural Major Collector",
    "08": "Rural Minor Collector",
    "09": "Rural Local",
    "11": "Urban Principal Arterial - Interstate",
    "12": "Urban Principal Arterial - Freeway/Expressway",
    "14": "Urban Principal Arterial - Other",
    "16": "Urban Minor Arterial",
    "17": "Urban Major Collector",
    "18": "Urban Minor Collector",
    "19": "Urban Local",
  };

  // Groups shown as checkboxes in the settings tab.
  const FC_GROUPS = [
    { key: "interstate", label: "Interstate (01/11)", codes: ["01", "11"] },
    { key: "fwyexp",     label: "Freeway/Expressway (02/12)", codes: ["02", "12"] },
    { key: "opa",        label: "Other Principal Arterial (04/14)", codes: ["04", "14"] },
    { key: "minart",     label: "Minor Arterial (06/16)", codes: ["06", "16"] },
    { key: "majcol",     label: "Major Collector (07/17)", codes: ["07", "17"] },
    { key: "mincol",     label: "Minor Collector (08/18)", codes: ["08", "18"] },
    { key: "local",      label: "Local (09/19)", codes: ["09", "19"] },
  ];

  /**
   * Map an FDOT FUNCLASS code to the Waze road type it should be.
   *
   * @param {string} fc  Two-digit FUNCLASS code, e.g. "01", "14", "18".
   *                     Rural codes are 01-09, urban codes are 11-19
   *                     (urban = rural + 10, same meaning otherwise).
   * @returns {object|null} One of the RT entries above (e.g. RT.MAJOR_HIGHWAY),
   *                        or null if this FC shouldn't drive a road type.
   *
   * This is the "Locally-maintained" column of the USA road-type table
   * (https://www.waze.com/discuss/t/road-types/377949). It colors the overlay;
   * the mismatch check uses the full table via expectedRoadType() below, which
   * also considers the segment's highway designation. Urban and rural codes map
   * the same way. Tweak entries here as you learn local practice: e.g. change
   * 8 to RT.STREET to stop flagging minor collectors, or 2 to RT.FREEWAY for
   * limited-access toll expressways. Unknown codes return null (gray, never flagged).
   */
  const FC_TO_RT = {
    1: RT.FREEWAY,        // Principal Arterial - Interstate
    2: RT.MAJOR_HIGHWAY,  // Principal Arterial - Other Freeway/Expressway
    4: RT.MAJOR_HIGHWAY,  // Principal Arterial - Other
    6: RT.MINOR_HIGHWAY,  // Minor Arterial
    7: RT.PRIMARY_STREET, // Major Collector
    8: RT.PRIMARY_STREET, // Minor Collector
    9: RT.STREET,         // Local
  };

  function fcToRoadType(fc) {
    const n = Number(fc);
    if (!Number.isInteger(n) || n < 1 || n > 19) return null;
    return FC_TO_RT[n % 10] ?? null; // urban (11-19) = rural (01-09) + 10
  }

  // --- USA road-type table (FC row x highway-system column) -----------------
  // Florida (SER) follows the USA standard. FDOT codes 02/12 combine "Other
  // Freeway" and "Other Expressway"; we use the Expressway row (Major Highway)
  // as the minimum, since the data can't tell whether access is fully controlled.
  const F = RT.FREEWAY, MH = RT.MAJOR_HIGHWAY, mH = RT.MINOR_HIGHWAY, PS = RT.PRIMARY_STREET, St = RT.STREET;
  const SYSTEMS = ["interstate", "interstateBus", "us", "usBus", "state", "stateBus", "county", "local"];
  const SYSTEM_LABELS = {
    interstate: "Interstate", interstateBus: "Interstate BUS/SPUR/LOOP", us: "US Highway",
    usBus: "US BUS/SPUR/LOOP", state: "State Highway", stateBus: "State BUS/SPUR/LOOP",
    county: "County Route", local: "Locally-maintained",
  };
  //          Int IntBus US   USBus State StBus County Local
  const USA_TABLE = {
    1: [F,  F,  F,  F,  F,  F,  F,  F ], // Interstate
    2: [F,  MH, MH, MH, MH, MH, MH, MH], // Other Freeway/Expressway
    4: [F,  MH, MH, MH, MH, MH, MH, MH], // Other Principal Arterial
    6: [F,  MH, MH, mH, mH, mH, mH, mH], // Minor Arterial
    7: [F,  MH, MH, mH, mH, PS, PS, PS], // Major Collector
    8: [F,  MH, MH, mH, mH, PS, PS, PS], // Minor Collector
    9: [F,  MH, MH, mH, mH, PS, PS, St], // Local / not mapped
  };

  // Highway system from one WME street name, using Florida naming conventions
  // (I-275, US-41, US-41 BUS, SR-60, SR-60 SPUR, CR-581). ALT/BYP/CONN/TRUCK/
  // SCENIC stay in the parent column; BUS/SPUR/LOOP get their own column.
  function systemOfName(name) {
    if (!name) return "local";
    const n = name.toUpperCase();
    const bus = /\b(BUS|BUSINESS|SPUR|LOOP)\b/.test(n);
    if (/^I-\d+/.test(n)) return bus ? "interstateBus" : "interstate";
    if (/^US-\d+/.test(n)) return bus ? "usBus" : "us";
    if (/^(SR|FL)-\d+/.test(n)) return bus ? "stateBus" : "state";
    if (/^CR-\d+/.test(n)) return "county";
    return "local";
  }

  /** Expected road type for an FC code on a road in the given highway system. */
  function expectedRoadType(fc, system) {
    const n = Number(fc);
    const row = USA_TABLE[Number.isInteger(n) ? n % 10 : 9] ?? USA_TABLE[9];
    return row[SYSTEMS.indexOf(system)] ?? fcToRoadType(fc);
  }

  // ---------------------------------------------------------------------------

  const defaultSettings = {
    enabled: true,
    opacity: 0.6,
    mismatchesOnly: false,
    checkSrNames: true,
    groups: Object.fromEntries(FC_GROUPS.map((g) => [g.key, g.key !== "local"])),
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      return { ...defaultSettings, ...saved, groups: { ...defaultSettings.groups, ...(saved.groups || {}) } };
    } catch {
      return structuredClone(defaultSettings);
    }
  }
  const settings = loadSettings();
  const saveSettings = () => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

  let sdk;
  let ui = {};
  const fcFeatures = new Map(); // FID -> GeoJSON feature in the current view
  // segment id -> { segId, expected, actual, fid, flagged } for every in-view segment matched to an FC line
  const segMatchCache = new Map();
  let fetchController = null;
  let lastFetchInfo = "";

  // WME's Content Security Policy blocks page-level fetch() to arcgis.com, so
  // requests go through Tampermonkey (runs outside the page; needs @connect).
  function gmGetJson(url, signal) {
    return new Promise((resolve, reject) => {
      const abortErr = () => new DOMException("Aborted", "AbortError");
      if (signal?.aborted) return reject(abortErr());
      const req = GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "json",
        timeout: 30000,
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) return reject(new Error(`HTTP ${r.status}`));
          try {
            resolve(r.response ?? JSON.parse(r.responseText));
          } catch (e) {
            reject(new Error("Invalid JSON from ArcGIS"));
          }
        },
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Request timed out")),
        onabort: () => reject(abortErr()),
      });
      signal?.addEventListener("abort", () => req.abort(), { once: true });
    });
  }

  const debounce = (fn, ms) => {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  const enabledCodes = () =>
    FC_GROUPS.filter((g) => settings.groups[g.key]).flatMap((g) => g.codes);

  // ---------------------------------------------------------------------------
  // Data fetch

  // Page through an ArcGIS query for features intersecting the view box.
  async function queryInView(url, where, outFields, bbox, tolerance, signal) {
    const base = {
      where,
      geometry: bbox.join(","),
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      outSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields,
      orderByFields: "FID",
      maxAllowableOffset: String(tolerance),
      f: "geojson",
    };
    const collected = [];
    for (let page = 0, offset = 0; page < MAX_PAGES; page++) {
      const params = new URLSearchParams({ ...base, resultOffset: String(offset) });
      const json = await gmGetJson(`${url}?${params}`, signal);
      if (json.error) throw new Error(json.error.message || "ArcGIS error");
      collected.push(...json.features);
      offset += json.features.length;
      if (!json.properties?.exceededTransferLimit || !json.features.length) break;
    }
    return collected.filter((f) => f.geometry);
  }

  async function fetchFcForView() {
    if (!settings.enabled) return;
    const zoom = await sdk.Map.getZoomLevel();
    if (zoom < MIN_ZOOM) {
      fcFeatures.clear();
      await renderFc();
      await renderMismatches();
      setStatus(`Zoom in to ${MIN_ZOOM}+ to load data (now ${zoom}).`);
      return;
    }
    const codes = enabledCodes();

    fetchController?.abort();
    fetchController = new AbortController();
    const { signal } = fetchController;

    const bbox = await sdk.Map.getMapExtent();
    // Generalize geometry to ~1 screen pixel; no visual loss, much smaller payloads.
    const tolerance = (bbox[2] - bbox[0]) / Math.max(window.innerWidth, 800);

    setStatus("Loading…");
    let fc;
    try {
      fc = codes.length
        ? await queryInView(
            QUERY_URL,
            `FUNCLASS IN (${codes.map((c) => `'${c}'`).join(",")})`,
            "FID,FUNCLASS,ROADWAY,COUNTY,BEGIN_POST,END_POST",
            bbox, tolerance, signal
          )
        : [];
    } catch (err) {
      if (err.name === "AbortError") return; // superseded by a newer pan
      console.error(`[${SCRIPT_NAME}]`, err);
      setStatus(`Error loading data: ${err.message}`);
      return;
    }

    fcFeatures.clear();
    for (const f of fc) fcFeatures.set(f.properties.FID, f);
    lastFetchInfo = `${fcFeatures.size} FC lines · ${new Date().toLocaleTimeString()}`;
    await renderFc();
    await renderMismatches();
  }

  // ---------------------------------------------------------------------------
  // Rendering

  function styleFor(props) {
    const rt = fcToRoadType(props.fc);
    return rt ? rt.color : "#9E9E9E";
  }

  async function renderFc() {
    await sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER });
    if (settings.mismatchesOnly || !fcFeatures.size) return;

    const casings = [];
    const lines = [];
    for (const f of fcFeatures.values()) {
      const fc = f.properties.FUNCLASS;
      const rt = fcToRoadType(fc);
      const props = { fc, kind: "line" };
      lines.push({ type: "Feature", id: `fc-${f.properties.FID}`, geometry: f.geometry, properties: props });
      // White (Street) lines vanish on light imagery - draw a dark casing under them.
      if (rt === RT.STREET) {
        casings.push({
          type: "Feature",
          id: `fc-${f.properties.FID}-casing`,
          geometry: f.geometry,
          properties: { fc, kind: "casing" },
        });
      }
    }
    // Casings first so they draw underneath.
    await sdk.Map.addFeaturesToLayer({ layerName: LAYER, features: [...casings, ...lines] });
  }

  // ---------------------------------------------------------------------------
  // Mismatch detection

  const M_PER_DEG_LAT = 111320;
  const MATCH_DIST_M = 20;
  const MATCH_ANGLE_DEG = 30;
  // A correctly typed road running alongside within this distance "covers" a
  // lower-typed helper segment (turn lane, connector, frontage road).
  const COVER_DIST_M = 30;
  const CELL_M = 100;

  // Local equirectangular projection to meters around a reference latitude.
  function projector(refLat) {
    const kx = M_PER_DEG_LAT * Math.cos((refLat * Math.PI) / 180);
    return ([lon, lat]) => [lon * kx, lat * M_PER_DEG_LAT];
  }

  function linesOf(geom) {
    if (!geom) return [];
    if (geom.type === "LineString") return [geom.coordinates];
    if (geom.type === "MultiLineString") return geom.coordinates;
    return [];
  }

  // Undirected bearing in degrees [0,180).
  const bearing = (a, b) => ((Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI + 180) % 180;
  const angleDiff = (a, b) => {
    const d = Math.abs(a - b) % 180;
    return Math.min(d, 180 - d);
  };

  function distPointToSeg(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    let t = len2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }

  // Midpoint (by length) of a projected polyline, plus the bearing of the piece it falls on.
  function midpointAndBearing(pts) {
    let total = 0;
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    let half = total / 2;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (half <= l || i === pts.length - 1) {
        const t = l ? Math.min(1, half / l) : 0;
        return { p: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], brg: bearing(a, b), a, b };
      }
      half -= l;
    }
    return null;
  }

  // Spatial grid of line pieces { a, b, ... } (projected meters). Returns a
  // lookup giving the pieces in the 3x3 cells around a point.
  function makeGrid() {
    const grid = new Map();
    return {
      add(entry) {
        const { a, b } = entry;
        const x0 = Math.floor(Math.min(a[0], b[0]) / CELL_M);
        const x1 = Math.floor(Math.max(a[0], b[0]) / CELL_M);
        const y0 = Math.floor(Math.min(a[1], b[1]) / CELL_M);
        const y1 = Math.floor(Math.max(a[1], b[1]) / CELL_M);
        for (let x = x0; x <= x1; x++)
          for (let y = y0; y <= y1; y++) {
            const k = `${x}:${y}`;
            if (!grid.has(k)) grid.set(k, []);
            grid.get(k).push(entry);
          }
      },
      near(p) {
        const out = [];
        const cx = Math.floor(p[0] / CELL_M);
        const cy = Math.floor(p[1] / CELL_M);
        for (let dx = -1; dx <= 1; dx++)
          for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${cx + dx}:${cy + dy}`) || []));
        return out;
      },
    };
  }

  function buildFcIndex(project) {
    const grid = makeGrid();
    for (const f of fcFeatures.values()) {
      const rt = fcToRoadType(f.properties.FUNCLASS);
      if (!rt) continue;
      for (const line of linesOf(f.geometry)) {
        const pts = line.map(project);
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          grid.add({ a, b, brg: bearing(a, b), rt, fid: f.properties.FID });
        }
      }
    }
    return grid;
  }

  // One-way direction relative to geometry order (A→B): 1, -1, or 0 for two-way.
  const travelDir = (seg) => (seg.isTwoWay ? 0 : seg.isAtoB ? 1 : seg.isBtoA ? -1 : 0);

  // Directed angle (0-180) between two pieces, each flipped by its travel direction.
  function travelAngle(a1, b1, dir1, a2, b2, dir2) {
    const h = (a, b, d) => Math.atan2((b[1] - a[1]) * d, (b[0] - a[0]) * d);
    const diff = Math.abs(h(a1, b1, dir1) - h(a2, b2, dir2)) * (180 / Math.PI);
    return diff > 180 ? 360 - diff : diff;
  }

  // True if another segment, typed at least `minRank`, runs alongside `cand`
  // in the same direction of travel. Opposite one-ways (the other carriageway
  // of a divided road) don't count, so a mistyped carriageway is still flagged.
  function isCovered(cand, minRank, segGrid) {
    for (const e of segGrid.near(cand.mb.p)) {
      if (e.segId === cand.seg.id || e.rank < minRank) continue;
      if (angleDiff(e.brg, cand.mb.brg) > MATCH_ANGLE_DEG) continue;
      if (distPointToSeg(cand.mb.p, e.a, e.b) > COVER_DIST_M) continue;
      const candDir = travelDir(cand.seg);
      if (candDir && e.dir && travelAngle(cand.mb.a, cand.mb.b, candDir, e.a, e.b, e.dir) > 90) continue;
      return true;
    }
    return false;
  }

  // Every Florida State Road number (numeric part only). Snapshot taken
  // 2026-11-04 from FDOT State_Roads_TDA (513 numbers) plus routes listed on
  // Wikipedia's "List of state roads in Florida" but missing from that layer
  // (525, 575, 581, 607, 615, 732, 850). Interstates and US routes also carry
  // hidden SR numbers (e.g. I-75 = SR-93, US-19 = SR-55), so those are included.
  const FL_STATE_ROADS = new Set((
    "2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 28 29 30 31 33 35 37 39 40 41 " +
    "43 44 45 46 47 48 49 50 51 52 53 54 55 56 57 59 60 61 62 63 64 65 66 68 69 70 71 72 73 75 76 77 " +
    "78 79 80 81 82 83 84 85 87 89 90 91 93 94 95 97 99 100 101 102 103 104 105 106 109 111 112 113 " +
    "114 115 116 117 118 120 121 122 123 126 128 129 134 136 139 143 145 152 155 157 159 160 162 166 " +
    "173 187 188 189 190 196 200 201 202 206 207 208 210 211 212 222 223 224 226 228 230 231 235 238 " +
    "243 247 249 253 261 262 263 265 267 269 273 275 276 277 279 281 283 285 287 289 291 292 293 294 " +
    "295 296 297 298 300 312 320 321 326 327 331 345 349 359 361 363 366 368 369 370 371 373 375 377 " +
    "384 385 388 389 390 391 392 393 397 399 400 401 404 405 406 407 408 410 411 412 413 414 415 416 " +
    "417 419 421 423 424 426 429 430 432 434 435 436 437 438 441 442 451 453 460 461 462 463 464 465 " +
    "466 467 469 471 472 482 483 492 500 501 507 508 510 512 513 514 517 518 519 520 524 525 526 527 " +
    "528 530 531 533 535 536 537 538 539 540 542 544 545 546 547 548 549 551 552 553 555 557 558 559 " +
    "560 561 562 563 564 565 566 567 568 569 570 571 572 573 574 575 577 579 580 581 582 583 584 585 " +
    "586 587 589 590 591 592 593 594 595 596 597 599 600 606 607 608 611 613 614 615 616 618 620 628 " +
    "636 647 649 651 653 655 656 657 658 659 660 661 662 663 664 665 666 667 671 673 674 675 676 678 " +
    "679 681 682 683 684 685 686 687 688 689 690 692 693 694 699 700 704 706 708 710 712 713 714 715 " +
    "716 717 718 727 729 732 736 739 740 742 750 752 754 758 762 768 769 776 777 780 786 789 794 800 " +
    "802 804 805 806 807 808 809 810 811 812 814 816 817 818 820 821 822 823 824 825 826 833 834 836 " +
    "838 842 843 844 845 846 847 848 849 850 852 856 858 860 862 863 864 865 867 869 870 874 876 878 " +
    "880 882 884 886 887 907 909 913 915 916 918 922 923 924 925 927 928 929 932 933 934 938 939 944 " +
    "948 949 951 953 958 959 960 961 962 963 968 969 970 972 973 975 976 979 985 986 988 989 990 992 " +
    "994 996 997 998 1010 1051 1151 1153 1155 2221 5001 5005 5009 5050 5052 5054 9336"
  ).split(" "));

  // "SR-420", "SR-9A", "SR-60 BUS" -> "420", "9", "60". Numbers only: FDOT's
  // letter suffixes (5A, 30F, 19S) don't consistently match signage.
  const srNumberOfName = (name) => name?.toUpperCase().match(/^(?:SR|FL)-(\d+)/)?.[1] ?? null;

  // SR-xxx names whose number isn't a Florida State Road anywhere.
  const invalidSrNames = (names) =>
    [...new Set(names)].filter((n) => {
      const num = srNumberOfName(n);
      return num && !FL_STATE_ROADS.has(num);
    });

  // Street names (primary + alternates) for a segment, cached by street id.
  const streetNameCache = new Map();
  async function streetNamesOf(seg) {
    const ids = [seg.primaryStreetId, ...(seg.alternateStreetIds || [])].filter((id) => id != null);
    const names = [];
    for (const id of ids) {
      if (!streetNameCache.has(id)) {
        const st = await sdk.DataModel.Streets.getById({ streetId: id });
        streetNameCache.set(id, st?.name || null);
      }
      const name = streetNameCache.get(id);
      if (name) names.push(name);
    }
    return names;
  }

  async function renderMismatches() {
    await sdk.Map.removeAllFeaturesFromLayer({ layerName: MISMATCH_LAYER });
    await sdk.Map.removeAllFeaturesFromLayer({ layerName: SR_LAYER });
    segMatchCache.clear();
    const checkSr = settings.checkSrNames;
    if (!settings.enabled || (!fcFeatures.size && !checkSr)) return;

    const [minLon, minLat, maxLon, maxLat] = await sdk.Map.getMapExtent();
    const project = projector((minLat + maxLat) / 2);
    const fcGrid = buildFcIndex(project);
    const segGrid = makeGrid();
    const segments = await sdk.DataModel.Segments.getAll();

    // Pass 1: index every comparable segment in view.
    const inView = [];
    for (const seg of segments) {
      const segRt = RANK_BY_ROAD_TYPE[seg.roadType];
      if (!segRt || !seg.geometry) continue;
      const coords = seg.geometry.coordinates;
      if (!coords.some(([x, y]) => x >= minLon && x <= maxLon && y >= minLat && y <= maxLat)) continue;
      const pts = coords.map(project);
      const mb = midpointAndBearing(pts);
      if (!mb) continue;
      const dir = travelDir(seg);
      for (let i = 1; i < pts.length; i++) {
        segGrid.add({ a: pts[i - 1], b: pts[i], brg: bearing(pts[i - 1], pts[i]), rank: segRt.rank, dir, segId: seg.id });
      }
      inView.push({ seg, segRt, mb });
    }

    // Pass 2: check SR names, then match each segment to an FC line and flag under-typed ones.
    const flagged = [];
    const srFlagged = [];
    for (const cand of inView) {
      const { seg, segRt, mb } = cand;
      let best = null;
      let bestD = Infinity;
      for (const e of fcGrid.near(mb.p)) {
        if (angleDiff(e.brg, mb.brg) > MATCH_ANGLE_DEG) continue;
        const d = distPointToSeg(mb.p, e.a, e.b);
        if (d < bestD && d <= MATCH_DIST_M) {
          bestD = d;
          best = e;
        }
      }
      const names = await streetNamesOf(seg);
      const srIssues = checkSr ? invalidSrNames(names) : [];
      if (srIssues.length) {
        srFlagged.push({ type: "Feature", id: `sr-${seg.id}`, geometry: seg.geometry, properties: { segId: seg.id } });
      }
      if (!best) {
        if (srIssues.length) {
          segMatchCache.set(seg.id, { segId: seg.id, actual: segRt.label, names, srIssues, fid: null });
        }
        continue;
      }
      const fc = fcFeatures.get(best.fid)?.properties.FUNCLASS;
      // A segment carrying several designations takes the highest requirement.
      // SR names that aren't real Florida State Roads are ignored, so a bad
      // name shows as an SR-name issue instead of a misleading road-type flag.
      let system = "local";
      let expected = expectedRoadType(fc, "local");
      for (const name of names) {
        if (srIssues.includes(name)) continue;
        const sys = systemOfName(name);
        const rt = expectedRoadType(fc, sys);
        if (rt.rank > expected.rank) {
          expected = rt;
          system = sys;
        }
      }
      const isFlagged = segRt.rank < expected.rank && !isCovered(cand, expected.rank, segGrid);
      segMatchCache.set(seg.id, {
        segId: seg.id, expected: expected.label, actual: segRt.label, fid: best.fid, flagged: isFlagged,
        system: SYSTEM_LABELS[system], names, srIssues,
      });
      if (isFlagged) {
        flagged.push({
          type: "Feature",
          id: `mm-${seg.id}`,
          geometry: seg.geometry,
          properties: { segId: seg.id },
        });
      }
    }
    if (flagged.length) await sdk.Map.addFeaturesToLayer({ layerName: MISMATCH_LAYER, features: flagged });
    if (srFlagged.length) await sdk.Map.addFeaturesToLayer({ layerName: SR_LAYER, features: srFlagged });
    showSelectedSegmentInfo(); // refresh in case the selected segment's match changed
    setStatus(
      `${lastFetchInfo} · ${flagged.length} under-typed segment(s)` +
        (checkSr ? ` · ${srFlagged.length} SR-name issue(s)` : "")
    );
  }

  // ---------------------------------------------------------------------------
  // UI

  function setStatus(text) {
    if (ui.status) ui.status.textContent = text;
  }

  function showInfo(fid, mismatch) {
    const f = fcFeatures.get(Number(fid));
    if (!ui.info) return;
    ui.info.replaceChildren();
    const row = (k, v) => {
      const div = document.createElement("div");
      const b = document.createElement("b");
      b.textContent = `${k}: `;
      div.append(b, document.createTextNode(v ?? "—"));
      ui.info.append(div);
    };
    if (mismatch) {
      row("Segment", mismatch.segId);
      row("Current type", mismatch.actual);
      row("Names", mismatch.names?.length ? mismatch.names.join(", ") : "(none)");
      if (mismatch.srIssues?.length) {
        row("SR name check", `${mismatch.srIssues.join(", ")} is not a Florida State Road`);
      } else if (settings.checkSrNames && mismatch.names?.some(srNumberOfName)) {
        row("SR name check", "OK");
      }
      if (mismatch.expected) {
        row("Highway system", mismatch.system);
        row("Expected type", mismatch.expected);
        row("Flagged", mismatch.flagged ? "Yes – typed lower than FC" : "No");
      } else {
        row("FC", "No FC line matched");
      }
    }
    if (f) {
      const p = f.properties;
      const rt = fcToRoadType(p.FUNCLASS);
      row("Roadway ID", p.ROADWAY);
      row("FUNCLASS", `${p.FUNCLASS} - ${FC_LABELS[p.FUNCLASS] || "Unknown"}`);
      row("County", p.COUNTY);
      row("Milepost", `${p.BEGIN_POST?.toFixed(3)} - ${p.END_POST?.toFixed(3)}`);
      row("FC alone suggests", rt ? rt.label : "(no mapping)");
    }
  }

  function legendSwatch(color) {
    const s = document.createElement("span");
    s.style.cssText = `display:inline-block;width:22px;height:6px;margin-right:6px;vertical-align:middle;background:${color};border:1px solid #333;`;
    return s;
  }

  async function buildTab() {
    const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = "FL FC";
    tabLabel.title = SCRIPT_NAME;

    const wrap = document.createElement("div");
    wrap.style.cssText = "padding:8px;font-size:13px;line-height:1.5";
    const h = document.createElement("h4");
    h.textContent = SCRIPT_NAME;
    wrap.append(h);

    const checkbox = (label, checked, onChange) => {
      const l = document.createElement("label");
      l.style.cssText = "display:block;font-weight:normal;cursor:pointer";
      const c = document.createElement("input");
      c.type = "checkbox";
      c.checked = checked;
      c.style.marginRight = "6px";
      c.addEventListener("change", () => onChange(c.checked));
      l.append(c, document.createTextNode(label));
      return l;
    };

    const classesHdr = document.createElement("b");
    classesHdr.textContent = "Classes";
    wrap.append(classesHdr);
    for (const g of FC_GROUPS) {
      const rt = fcToRoadType(g.codes[0]);
      const l = checkbox(g.label, settings.groups[g.key], (v) => {
        settings.groups[g.key] = v;
        saveSettings();
        fetchFcForView();
      });
      l.insertBefore(legendSwatch(rt ? rt.color : "#9E9E9E"), l.lastChild);
      wrap.append(l);
    }

    wrap.append(document.createElement("hr"));
    wrap.append(
      checkbox("Show mismatches only", settings.mismatchesOnly, async (v) => {
        settings.mismatchesOnly = v;
        saveSettings();
        await renderFc();
      })
    );

    const opLabel = document.createElement("label");
    opLabel.style.cssText = "display:block;font-weight:normal";
    opLabel.textContent = "Overlay opacity ";
    const op = document.createElement("input");
    op.type = "range";
    op.min = "0.1";
    op.max = "1";
    op.step = "0.05";
    op.value = String(settings.opacity);
    op.addEventListener("input", () => {
      settings.opacity = Number(op.value);
      saveSettings();
      sdk.Map.setLayerOpacity({ layerName: LAYER, opacity: settings.opacity });
    });
    opLabel.append(op);
    wrap.append(opLabel);

    wrap.append(
      checkbox("Check SR-xxx names against Florida State Road list", settings.checkSrNames, (v) => {
        settings.checkSrNames = v;
        saveSettings();
        renderMismatches();
      })
    );

    const mmLegend = document.createElement("div");
    mmLegend.append(legendSwatch("#FF1744"), document.createTextNode("Segment typed lower than FC suggests"));
    const srLegend = document.createElement("div");
    srLegend.append(legendSwatch("#FF9100"), document.createTextNode("SR number that isn't a Florida State Road"));
    wrap.append(mmLegend, srLegend);

    ui.status = document.createElement("div");
    ui.status.style.cssText = "margin-top:8px;color:#555;font-style:italic";
    wrap.append(ui.status);

    const infoHdr = document.createElement("b");
    infoHdr.textContent = "Selected segment";
    infoHdr.style.cssText = "display:block;margin-top:8px";
    ui.info = document.createElement("div");
    ui.info.textContent = "Select a segment to see its FC match.";
    wrap.append(infoHdr, ui.info);

    const src = document.createElement("div");
    src.style.cssText = "margin-top:10px;font-size:11px;color:#777";
    src.textContent = "Data: FDOT TDA Functional Classification (Feature 121). May not reflect current conditions.";
    wrap.append(src);

    tabPane.append(wrap);
  }

  // ---------------------------------------------------------------------------
  // Layers & events

  async function setupLayers() {
    await sdk.Map.addLayer({
      layerName: LAYER,
      styleContext: {
        color: ({ feature }) => (feature?.properties.kind === "casing" ? "#222222" : styleFor(feature?.properties || {})),
        width: ({ feature, zoomLevel }) => {
          const w = zoomLevel >= 17 ? 12 : zoomLevel >= 15 ? 9 : 6;
          return feature?.properties.kind === "casing" ? w + 3 : w;
        },
      },
      styleRules: [
        {
          style: {
            strokeColor: "${color}",
            strokeWidth: "${width}",
            strokeOpacity: 1,
            strokeLinecap: "round",
            fill: false,
          },
        },
      ],
    });
    await sdk.Map.addLayer({
      layerName: MISMATCH_LAYER,
      styleRules: [
        {
          style: {
            strokeColor: "#FF1744",
            strokeWidth: 16,
            strokeOpacity: 0.85,
            strokeDashstyle: "dash",
            strokeLinecap: "butt",
            fill: false,
          },
        },
      ],
    });
    await sdk.Map.addLayer({
      layerName: SR_LAYER,
      styleRules: [
        {
          style: {
            strokeColor: "#FF9100",
            strokeWidth: 20,
            strokeOpacity: 0.85,
            strokeDashstyle: "dot",
            strokeLinecap: "round",
            fill: false,
          },
        },
      ],
    });
    await sdk.Map.setLayerOpacity({ layerName: LAYER, opacity: settings.opacity });
    await placeBelowSegments();

    await sdk.LayerSwitcher.addLayerCheckbox({ name: CHECKBOX_NAME, isChecked: settings.enabled });
    await applyVisibility();

    // No trackLayerEvents on our layers: tracking makes them interactive, and
    // they would swallow clicks meant for WME segments.
    sdk.Events.trackDataModelEvents({ dataModelName: "segments" });
  }

  // Draw both overlays underneath WME's segments so segments stay on top and clickable.
  async function placeBelowSegments() {
    try {
      const segZ = await sdk.Map.getLayerZIndex({ layerName: "segments" });
      await sdk.Map.setLayerZIndex({ layerName: LAYER, zIndex: segZ - 3 });
      await sdk.Map.setLayerZIndex({ layerName: SR_LAYER, zIndex: segZ - 2 });
      await sdk.Map.setLayerZIndex({ layerName: MISMATCH_LAYER, zIndex: segZ - 1 });
    } catch (e) {
      console.warn(`[${SCRIPT_NAME}] could not reorder layers`, e);
    }
  }

  // ArcGIS Map Viewer URL centered on lon/lat at the given zoom, with the FDOT FC
  // layer loaded and a marker on the spot. WME and ArcGIS both use standard web
  // mercator zoom levels, so the zoom carries over as-is.
  function fdotMapUrl(lon, lat, zoom, title) {
    const x = lon.toFixed(6);
    const y = lat.toFixed(6);
    const params = [
      `layers=${FDOT_LAYER_ITEM}`,
      `center=${x},${y}`,
      `level=${Math.round(Math.min(20, Math.max(10, zoom)))}`,
      `marker=${x};${y};;${encodeURIComponent(title)}`,
    ];
    return `${MAPVIEWER_URL}?${params.join("&")}`;
  }

  function appendFdotLink(url, text) {
    const div = document.createElement("div");
    div.style.marginTop = "6px";
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = text;
    div.append(a);
    ui.info.append(div);
  }

  // Midpoint (by length) of a lon/lat LineString. Degree-space is fine at this scale.
  function lonLatMidpoint(coords) {
    return midpointAndBearing(coords)?.p ?? coords[0];
  }

  async function showSelectedSegmentInfo() {
    if (!ui.info) return;
    const sel = await sdk.Editing.getSelection();
    const zoom = await sdk.Map.getZoomLevel();
    if (!sel || String(sel.objectType).toLowerCase() !== "segment" || !sel.ids.length) {
      ui.info.textContent = "Select a segment to see its FC match.";
      const c = await sdk.Map.getMapCenter();
      appendFdotLink(fdotMapUrl(c.lon, c.lat, zoom, "WME map center"), "Open FDOT FC map here ↗");
      return;
    }
    const segId = sel.ids[0];
    const match = segMatchCache.get(segId);
    if (match) showInfo(match.fid, match);
    else ui.info.textContent = `Segment ${segId}: no FC line matched (or not in view).`;

    const seg = await sdk.DataModel.Segments.getById({ segmentId: segId });
    const coords = seg?.geometry?.coordinates;
    if (coords?.length) {
      const [lon, lat] = lonLatMidpoint(coords);
      appendFdotLink(fdotMapUrl(lon, lat, zoom, `WME segment ${segId}`), "Open this segment in the FDOT FC map ↗");
    }
  }

  async function applyVisibility() {
    await sdk.Map.setLayerVisibility({ layerName: LAYER, visibility: settings.enabled });
    await sdk.Map.setLayerVisibility({ layerName: MISMATCH_LAYER, visibility: settings.enabled });
    await sdk.Map.setLayerVisibility({ layerName: SR_LAYER, visibility: settings.enabled });
  }

  function wireEvents() {
    const refetch = debounce(fetchFcForView, 500);
    const recheck = debounce(renderMismatches, 750);

    const refreshInfo = debounce(showSelectedSegmentInfo, 500);
    sdk.Events.on({ eventName: "wme-map-move-end", eventHandler: refetch });
    // Keeps the "open FDOT map here" link pointing at the current map center.
    sdk.Events.on({ eventName: "wme-map-move-end", eventHandler: refreshInfo });

    sdk.Events.on({
      eventName: "wme-layer-checkbox-toggled",
      eventHandler: async ({ name, checked }) => {
        if (name !== CHECKBOX_NAME) return;
        settings.enabled = checked;
        saveSettings();
        await applyVisibility();
        if (checked) fetchFcForView();
      },
    });

    sdk.Events.on({ eventName: "wme-selection-changed", eventHandler: () => showSelectedSegmentInfo() });

    for (const ev of ["wme-data-model-objects-added", "wme-data-model-objects-changed"]) {
      sdk.Events.on({
        eventName: ev,
        eventHandler: ({ dataModelName }) => {
          if (dataModelName === "segments") recheck();
        },
      });
    }
  }

  // ---------------------------------------------------------------------------

  async function init() {
    sdk = unsafeWindow.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME, mode: "async" });
    if (!(await sdk.State.isReady())) await sdk.Events.once({ eventName: "wme-ready" });
    await buildTab();
    await setupLayers();
    wireEvents();
    await showSelectedSegmentInfo();
    await fetchFcForView();
    console.log(`[${SCRIPT_NAME}] ready`);
  }

  const start = () => unsafeWindow.SDK_INITIALIZED.then(init).catch((e) => console.error(`[${SCRIPT_NAME}]`, e));
  if (unsafeWindow.SDK_INITIALIZED) start();
  else document.addEventListener("wme-sdk-initialized", start, { once: true });
})();
