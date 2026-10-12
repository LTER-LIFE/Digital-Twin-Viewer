// The Export section: figure and chart PNGs, series / profile / pair CSVs,
// selections as JSON, and the shareable link. Every file carries enough
// provenance (dataset, grid, datum, layer, precision, sampling caveat) to stay
// interpretable away from this app.

import {
  meta, DS, NX, NY, NDAYS, STEP_DAYS, TITLE, STEP_WORD, DATUM, LEVEL_UNIT, ST, latlon,
} from '../core/dataset.js';
import { stepDate, ALIASED, ALIAS_TEXT } from '../core/calendar.js';
import {
  figurePNG, csvHeader, seriesCSV, selectionsJSON, saveBlob, PROFILE_COLS,
} from '../export.js';
import { quantum } from '../timeseries.js';
import { renderer, scene, camera, viewW, viewH } from '../render/viewport.js';
import { $, fmtNum, niceName, withUnits, slugify } from '../util.js';
import { shell, extractor, columns, obs, selections } from './services.js';
import { stepIndex } from './time.js';
import { varState, colourScale, currentSource, vertVar, layerLabel } from './variables.js';
import { areaStat } from './selectionPanel.js';
import { urlState } from './urlSync.js';
import { scaleBar, northDeg } from './hud.js';
import { seriesChart, domainSeries, SEA_CELLS } from '../dock/series.js';
import { profileChart } from '../dock/profile.js';
import { vertChart } from '../dock/vertical.js';
import { hovChart } from '../dock/hovmoller.js';
import { validationGroups } from '../dock/validation.js';

const exportInfo = () => ({
  title: TITLE, nx: NX, ny: NY, cellKm: meta.cellKm, nDays: NDAYS,
  stepDays: STEP_DAYS, startDate: meta.startDate, datum: DATUM,
  layer: varState ? layerLabel(varState) : null,
  precision: varState
    ? (varState.bytes === 2
      ? `uint16 over ${fmtNum(varState.dataMin)}..${fmtNum(varState.dataMax)} (step ${fmtNum(quantum(varState))})`
      : `uint8 over the 1-99 percentile ${fmtNum(varState.lo)}..${fmtNum(varState.hi)} (step ${fmtNum(quantum(varState))}, tails clipped)`)
    : null,
  caveat: ALIAS_TEXT,
  url: urlState.href(),
});

async function saveFigure() {
  const btn = $('b-fig');
  btn.disabled = true;
  const was = btn.textContent;
  btn.textContent = 'Rendering…';
  try {
    const scale = parseInt($('fig-scale').value, 10);
    const t = stepIndex();
    const blob = await figurePNG({
      renderer, scene, camera, width: viewW, height: viewH, scale,
      caption: $('fig-caption').checked ? {
        title: TITLE,
        subtitle: `${NX}×${NY} @ ${meta.cellKm} km · V.E. ${$('r-exag').value}× · ` +
          (varState ? withUnits(varState) : 'water level and intertidal state'),
        date: `${stepDate(t).toISOString().slice(0, 10)} · ${STEP_WORD} ${t + 1}/${NDAYS}`,
        variable: varState ? withUnits(varState) : null,
        units: varState ? varState.units : '',
        range: varState ? [colourScale.lo, colourScale.hi] : null,
        cmap: colourScale.cmap,
        rev: colourScale.rev,
        log: colourScale.log,
        exag: $('r-exag').value,
        scaleBar,
        northDeg: northDeg(),
        attribution: meta.satellite ? (meta.satelliteAttribution || 'Imagery © Esri') : '',
        note: ALIASED ? 'Instantaneous snapshot; daily sampling aliases the tidal cycle.' : '',
      } : null,
    });
    saveBlob(blob, `${slugify(TITLE)}-${stepDate(t).toISOString().slice(0, 10)}${varState ? '-' + varState.key : ''}.png`);
  } catch (err) {
    alert('Could not render the figure:\n' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
}

async function saveChartPNG() {
  // A collapsed dock means the chart canvas has no size and would export blank.
  // Open it and let layout settle before capturing.
  if (!shell.dockOpen) {
    shell.setDock(true);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }
  const chart = shell.tab === 'series' ? seriesChart
    : shell.tab === 'profile' ? profileChart
    : shell.tab === 'vert' ? vertChart : hovChart;
  if (!chart.cv.clientWidth || !chart.cv.clientHeight) {
    alert('The chart has no size to export yet — open the chart dock and try again.');
    return;
  }
  saveBlob(await chart.toBlob(3), `${slugify(TITLE)}-${shell.tab}.png`);
}

function saveSeriesCSV() {
  const src = currentSource();
  const rows = [];
  // Report one digit past the resolution the value actually has and no more.
  // Writing 0.38991605 for a number stored in 2.6e-3 steps claims six digits of
  // precision that do not exist, and a reader has no way to know that.
  const decimalsFor = (q) => Math.min(9, Math.max(0, Math.ceil(-Math.log10(q)) + 1));
  const push = (sel, label, units, stat, r, q) => {
    const dp = decimalsFor(q);
    const cells = extractor.cells(sel);
    for (let t = 0; t < NDAYS; t++) {
      rows.push({
        selection: sel.name, type: sel.type, n_cells: cells.ks.length,
        step: t + 1, date: stepDate(t).toISOString().slice(0, 10),
        variable: label, units, statistic: stat,
        value: Number.isFinite(r.ys[t]) ? r.ys[t].toFixed(dp) : '',
        n_valid: r.n[t], wet_fraction: +r.wetFrac[t].toFixed(4),
      });
    }
  };
  const sels = selections.active;
  if (!sels.length) {
    // Nothing selected: export exactly what the chart is showing, which is the
    // domain mean of the active variable, or the exposed-flat curve when there
    // is no variable. Exporting something else would quietly hand back a
    // different series than the one on screen.
    if (src) {
      const d = domainSeries();
      const dp = decimalsFor(quantum(varState));
      for (let t = 0; t < NDAYS; t++) {
        const v = d.ys[t];
        rows.push({
          selection: 'domain', type: 'domain', n_cells: SEA_CELLS.length,
          step: t + 1, date: stepDate(t).toISOString().slice(0, 10),
          variable: niceName(varState), units: varState.units || '', statistic: 'mean',
          value: Number.isFinite(v) ? Number(v).toFixed(dp) : '',
          n_valid: '', wet_fraction: '',
        });
      }
    } else {
      for (let t = 0; t < NDAYS; t++) {
        rows.push({
          selection: 'domain', type: 'domain', n_cells: meta.seaCells,
          step: t + 1, date: stepDate(t).toISOString().slice(0, 10),
          variable: 'exposed flat area', units: 'km2', statistic: 'sum',
          value: ST.exposedKm2[t], n_valid: '', wet_fraction: '',
        });
      }
    }
  }
  for (const sel of sels) {
    const stat = sel.type === 'area' ? areaStat : 'mean';
    if (src) {
      push(sel, niceName(varState), varState.units || '', stat,
        extractor.series(sel, src, stat), quantum(varState));
    }
    // elev.bin is stored in centimetres, so a level is worth 0.01 m and no more
    push(sel, 'water level', LEVEL_UNIT, stat, extractor.series(sel, { kind: 'level' }, stat), 0.01);
    push(sel, 'water depth', 'm', stat, extractor.series(sel, { kind: 'depth' }, stat), 0.01);
  }
  if (!rows.length) { alert('Nothing to export yet.'); return; }
  saveBlob(seriesCSV({ header: csvHeader(exportInfo()), rows }),
    `${slugify(TITLE)}-series.csv`);
}

/** Every layer of every selected column, at every step. This is the number
 *  people take away and plot elsewhere, so it carries the geometry with it:
 *  without the layer's own top and bottom a sigma value is not locatable in
 *  space, and the depth would have to be guessed from the layer index. */
async function saveProfilesCSV() {
  const v = vertVar();
  const sels = selections.active;
  if (!v || !sels.length) { alert('Select a variable with profiles and a selection first.'); return; }
  const btn = $('b-vcsv');
  const was = btn.textContent;
  btn.textContent = 'Collecting…';
  btn.disabled = true;
  try {
    const rows = [];
    const q = (v.dataMax - v.dataMin) / (v.column.codeMax - 1);
    const dp = Math.min(9, Math.max(0, Math.ceil(-Math.log10(q)) + 1));
    for (const sel of sels) {
      const ks = Array.from(extractor.cells(sel).ks);
      const c = await columns.fetch(v, ks);
      if (!c) continue;
      for (let ci = 0; ci < c.ks.length; ci++) {
        const k = c.ks[ci];
        const i = Math.floor(k / NX), j = k % NX;
        for (let t = 0; t < c.nt; t++) {
          const z = columns.interfaces(k, t);
          if (!z) continue;
          for (let zi = 0; zi < c.nz; zi++) {
            const val = c.at(ci, t, zi);
            rows.push({
              selection: sel.name, type: sel.type, row: i, col: j,
              step: t + 1, date: stepDate(t).toISOString().slice(0, 10),
              layer: zi + 1, of_layers: c.nz,
              bottom_m: +z[zi].toFixed(3), top_m: +z[zi + 1].toFixed(3),
              mid_m: +((z[zi] + z[zi + 1]) / 2).toFixed(3),
              thickness_m: +(z[zi + 1] - z[zi]).toFixed(3),
              variable: niceName(v), units: v.units || '',
              value: Number.isFinite(val) ? +val.toFixed(dp) : '',
            });
          }
        }
      }
    }
    if (!rows.length) { alert('Nothing to export — the selection is dry.'); return; }
    saveBlob(seriesCSV({ header: csvHeader(exportInfo()), rows, cols: PROFILE_COLS }),
      `${slugify(TITLE)}-profiles.csv`);
  } finally {
    btn.textContent = was;
    btn.disabled = false;
  }
}

function saveSelectionsJSON() {
  const payload = {
    app: 'Wad-EMOaaS Digital Twin Viewer',
    generated: new Date().toISOString(),
    url: urlState.href(),
    dataset: {
      slug: DS, title: TITLE, nx: NX, ny: NY, cellKm: meta.cellKm,
      startDate: meta.startDate, stepDays: STEP_DAYS, nSteps: NDAYS,
      verticalDatum: DATUM, gridNorthDeg: meta.gridNorthDeg,
    },
    variable: varState ? {
      key: varState.key, name: varState.name, long: varState.long, units: varState.units,
      layer: layerLabel(varState), storedRange: [varState.storeLo, varState.storeHi],
      colourScale: { ...colourScale },
    } : null,
    step: { index: stepIndex(), date: stepDate(stepIndex()).toISOString() },
    caveat: ALIAS_TEXT,
    selections: selections.list.map((s) => {
      const c = extractor.cells(s);
      return {
        name: s.name, type: s.type, statistic: s.type === 'area' ? areaStat : 'mean',
        vertices_rowcol: s.pts.map(([i, j]) => [+i.toFixed(2), +j.toFixed(2)]),
        cells_rowcol: c.ij,
        cells_lonlat: latlon ? c.ij.map(([i, j]) => {
          const o = 2 * (i * NX + j);
          return [+latlon[o + 1].toFixed(6), +latlon[o].toFixed(6)];
        }) : null,
        length_km: s.type === 'transect' ? +(c.dist[c.dist.length - 1] || 0).toFixed(3) : null,
        area_km2: s.type === 'area' ? +(c.ks.length * meta.cellKm ** 2).toFixed(3) : null,
      };
    }),
  };
  saveBlob(selectionsJSON(payload), `${slugify(TITLE)}-selections.json`);
}

async function copyLink() {
  const href = urlState.href();
  const btn = $('b-link');
  const was = btn.textContent;
  try {
    await navigator.clipboard.writeText(href);
    btn.textContent = 'Copied ✓';
  } catch {
    // clipboard is blocked on insecure origins — show the link so it can be
    // copied by hand rather than failing silently
    prompt('Copy this link:', href);
    btn.textContent = was;
  }
  setTimeout(() => { btn.textContent = was; }, 1600);
}

function savePairsCSV() {
  const { groups, target } = validationGroups();
  const rows = [];
  const tname = target.desc ? target.desc.key : target.special;
  for (const g of groups) {
    for (const p of g.pairs) {
      const st = g.st, pt = p.p;
      const cell = st ? st.cell : pt.cell;
      rows.push({
        collection: (st ? st.coll : g.coll).id,
        station: st ? st.id : pt.station,
        lat: +(st ? st.lat : pt.lat).toFixed(6),
        lon: +(st ? st.lon : pt.lon).toFixed(6),
        cell_row: cell.i, cell_col: cell.j,
        snap_m: st ? Math.round(cell.snapKm * 1000) : '',
        time_utc: new Date(obs.msOfTau(p.t)).toISOString().slice(0, 19) + 'Z',
        step: +p.t.toFixed(4),
        obs_variable: g.m.key, obs_units_original: g.m.var.units || '',
        obs_value: +p.o.toPrecision(7),
        model_variable: tname, model_value: +p.m.toPrecision(7),
        units: target.units,
        datum_offset_removed: g.anomaly ? 'yes' : '',
      });
    }
  }
  if (!rows.length) {
    alert('Nothing to export yet: open the Model vs obs tab, or click a station on the map.');
    return;
  }
  const cols = ['collection', 'station', 'lat', 'lon', 'cell_row', 'cell_col', 'snap_m', 'time_utc',
    'step', 'obs_variable', 'obs_units_original', 'obs_value', 'model_variable', 'model_value', 'units',
    'datum_offset_removed'];
  const header = csvHeader(exportInfo()).replace(/#\n$/,
    '# pairs: observation converted to the model units; model at the station cell, brought to the\n'
    + '#        observation time (denser side sampled at the sparser side times); see OBSERVATIONS.md\n#\n');
  saveBlob(seriesCSV({ header, rows, cols }), `${slugify(TITLE)}-${slugify(tname)}-obs-pairs.csv`);
}

export function initExportPanel() {
  $('b-fig').addEventListener('click', saveFigure);
  $('b-chartpng').addEventListener('click', saveChartPNG);
  $('b-csv').addEventListener('click', saveSeriesCSV);
  $('b-vcsv').addEventListener('click', saveProfilesCSV);
  $('b-json').addEventListener('click', saveSelectionsJSON);
  $('b-link').addEventListener('click', copyLink);
  $('b-pcsv').addEventListener('click', savePairsCSV);
}
