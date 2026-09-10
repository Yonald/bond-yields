/* 30-year sovereign yields — rendering and interaction.
   No build step, no dependencies. Charts are hand-drawn SVG. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const ORDER = ['US', 'DE', 'UK', 'FR', 'CA', 'JP'];
const RANGES = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '3Y': 1095 };

const state = { data: null, range: '1Y', hidden: new Set() };

const el = (id) => document.getElementById(id);
const colour = (code) => `var(--${code.toLowerCase()})`;

function make(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/* ---------- data helpers ---------- */

// Series are [isoDate, yield] sorted ascending.
function windowed(series, days) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const slice = series.filter(([d]) => d >= cutoff);
  return slice.length > 1 ? slice : series.slice(-2);
}

// Value at or immediately before a target date — bond markets have gaps.
function asOf(series, targetIso) {
  let found = null;
  for (const [d, v] of series) {
    if (d <= targetIso) found = v;
    else break;
  }
  return found;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
}

function changes(series, monthly = false) {
  const last = series[series.length - 1][1];
  const prev = series.length > 1 ? series[series.length - 2][1] : null;
  const jan1 = `${new Date().getFullYear() - 1}-12-31`;
  const bp = (from) => (from == null ? null : Math.round((last - from) * 100));
  return {
    // A monthly average has no meaningful daily or weekly delta.
    '1d': monthly ? null : bp(prev),
    '1w': monthly ? null : bp(asOf(series, daysAgo(7))),
    // Monthly data publishes in arrears, so "30 days ago" often lands on the
    // latest point itself. Compare against the previous observation instead.
    '1m': monthly ? bp(prev) : bp(asOf(series, daysAgo(30))),
    YTD: bp(asOf(series, jan1)),
  };
}

function fmtBp(v) {
  if (v == null) return { text: '—', cls: 'flat' };
  const sign = v > 0 ? '+' : v < 0 ? '\u2212' : '';
  return {
    text: `${sign}${Math.abs(v)} bp`,
    cls: v > 0 ? 'up' : v < 0 ? 'down' : 'flat',
  };
}

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/* ---------- shared scale maths ---------- */

function niceTicks(min, max, count = 5) {
  const span = max - min || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) * mag;
  const ticks = [];
  for (let t = Math.ceil(min / step) * step; t <= max + 1e-9; t += step) {
    ticks.push(Number(t.toFixed(10)));
  }
  return ticks;
}

function buildScale(seriesList, box) {
  const all = seriesList.flat();
  const dates = [...new Set(all.map(([d]) => d))].sort();
  const values = all.map(([, v]) => v);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const pad = (hi - lo || 0.5) * 0.12;
  lo -= pad;
  hi += pad;
  const t0 = Date.parse(dates[0]);
  const t1 = Date.parse(dates[dates.length - 1]) || t0 + 1;
  return {
    dates,
    lo,
    hi,
    x: (iso) => box.l + ((Date.parse(iso) - t0) / (t1 - t0 || 1)) * box.w,
    y: (v) => box.t + (1 - (v - lo) / (hi - lo || 1)) * box.h,
  };
}

function pathFor(series, scale) {
  return series
    .map(([d, v], i) => `${i ? 'L' : 'M'}${scale.x(d).toFixed(2)},${scale.y(v).toFixed(2)}`)
    .join('');
}

/* ---------- hero chart ---------- */

function drawHero() {
  const svg = el('hero');
  svg.textContent = '';
  // A narrower viewBox on small screens keeps 12px labels legible once scaled.
  const narrow = window.innerWidth < 700;
  const W = narrow ? 460 : 1000;
  const H = narrow ? 360 : 420;
  const box = { l: narrow ? 34 : 46, t: 16, w: 0, h: H - 16 - 34 };
  box.w = W - box.l - (narrow ? 34 : 58);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const days = RANGES[state.range];
  const visible = ORDER.filter((c) => state.data.countries[c] && !state.hidden.has(c));
  if (!visible.length) return;

  const seriesMap = {};
  visible.forEach((c) => {
    seriesMap[c] = windowed(state.data.countries[c].series, days);
  });
  const scale = buildScale(Object.values(seriesMap), box);

  // horizontal gridlines + y labels
  niceTicks(scale.lo, scale.hi).forEach((t) => {
    const y = scale.y(t);
    svg.append(
      make('line', {
        x1: box.l, x2: box.l + box.w, y1: y, y2: y,
        stroke: 'var(--rule)', 'stroke-width': 1,
      })
    );
    const label = make('text', {
      x: box.l - 9, y: y + 4, 'text-anchor': 'end',
      fill: 'var(--faint)', 'font-size': 12,
    });
    label.textContent = t.toFixed(2);
    svg.append(label);
  });

  // x labels at start / middle / end
  [0, Math.floor(scale.dates.length / 2), scale.dates.length - 1].forEach((i) => {
    const iso = scale.dates[i];
    const label = make('text', {
      x: scale.x(iso), y: H - 12,
      'text-anchor': i === 0 ? 'start' : i === scale.dates.length - 1 ? 'end' : 'middle',
      fill: 'var(--faint)', 'font-size': 12,
    });
    label.textContent = new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {
      month: 'short', year: '2-digit', timeZone: 'UTC',
    });
    svg.append(label);
  });

  // one line per country
  visible.forEach((code) => {
    const series = seriesMap[code];
    svg.append(
      make('path', {
        d: pathFor(series, scale),
        fill: 'none',
        stroke: colour(code),
        'stroke-width': 1.9,
        'stroke-linejoin': 'round',
        'stroke-linecap': 'round',
        ...(state.data.countries[code].freq === 'monthly'
          ? { 'stroke-dasharray': '5 4' }
          : {}),
      })
    );
    const [lastDate, lastVal] = series[series.length - 1];
    svg.append(
      make('circle', { cx: scale.x(lastDate), cy: scale.y(lastVal), r: 3, fill: colour(code) })
    );
  });

  // End-of-line country tags, nudged apart so close yields stay readable.
  const GAP = 13;
  const tags = visible
    .map((code) => {
      const series = seriesMap[code];
      return { code, y: scale.y(series[series.length - 1][1]) };
    })
    .sort((a, b) => a.y - b.y);

  for (let i = 1; i < tags.length; i++) {
    if (tags[i].y - tags[i - 1].y < GAP) tags[i].y = tags[i - 1].y + GAP;
  }
  const overflow = tags.length ? tags[tags.length - 1].y - (box.t + box.h) : 0;
  if (overflow > 0) tags.forEach((t) => (t.y -= overflow));

  tags.forEach(({ code, y }) => {
    const anchorY = scale.y(seriesMap[code][seriesMap[code].length - 1][1]);
    if (Math.abs(anchorY - y) > 2) {
      svg.append(
        make('line', {
          x1: box.l + box.w + 2, x2: box.l + box.w + 6,
          y1: anchorY, y2: y,
          stroke: colour(code), 'stroke-width': 1, opacity: 0.55,
        })
      );
    }
    const tag = make('text', {
      x: box.l + box.w + 9, y: y + 4,
      fill: colour(code), 'font-size': 12, 'font-weight': 600,
    });
    tag.textContent = code;
    svg.append(tag);
  });

  const crosshair = make('line', {
    y1: box.t, y2: box.t + box.h,
    stroke: 'var(--ink)', 'stroke-width': 1,
    'stroke-dasharray': '3 3', opacity: 0,
  });
  svg.append(crosshair);

  attachTooltip(svg, box, scale, seriesMap, visible, crosshair);
}

/* ---------- tooltip / crosshair ---------- */

function attachTooltip(svg, box, scale, seriesMap, visible, crosshair) {
  const tip = el('tip');

  const move = (event) => {
    const rect = svg.getBoundingClientRect();
    const vbScale = rect.width / svg.viewBox.baseVal.width;
    const point = event.touches ? event.touches[0] : event;
    const localX = (point.clientX - rect.left) / vbScale;
    if (localX < box.l - 4 || localX > box.l + box.w + 4) return hide();

    // nearest date on the shared axis
    let best = scale.dates[0];
    let bestGap = Infinity;
    for (const iso of scale.dates) {
      const gap = Math.abs(scale.x(iso) - localX);
      if (gap < bestGap) { bestGap = gap; best = iso; }
    }

    crosshair.setAttribute('x1', scale.x(best));
    crosshair.setAttribute('x2', scale.x(best));
    crosshair.setAttribute('opacity', 0.45);

    const rows = visible
      .map((code) => {
        const value = asOf(seriesMap[code], best);
        if (value == null) return '';
        return `<div class="trow"><span style="color:${colour(code)}">${code}</span><b>${value.toFixed(2)}%</b></div>`;
      })
      .join('');
    tip.innerHTML = `<div class="tdate">${fmtDate(best)}</div>${rows}`;
    tip.dataset.show = 'true';

    const width = tip.offsetWidth;
    let left = point.clientX + 16;
    if (left + width > window.innerWidth - 8) left = point.clientX - width - 16;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.min(point.clientY + 16, window.innerHeight - tip.offsetHeight - 8)}px`;
  };

  const hide = () => {
    tip.dataset.show = 'false';
    crosshair.setAttribute('opacity', 0);
  };

  svg.addEventListener('pointermove', move);
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('touchmove', move, { passive: true });
  svg.addEventListener('touchend', hide);
}

/* ---------- legend ---------- */

function drawLegend() {
  const host = el('legend');
  host.textContent = '';
  ORDER.forEach((code) => {
    const country = state.data.countries[code];
    if (!country) return;
    const shown = !state.hidden.has(code);
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(shown));
    button.style.color = colour(code);
    button.innerHTML =
      `<span class="swatch"></span>` +
      `<span class="lname" style="color:var(--ink)">${country.name}</span>` +
      `<span class="lval" style="color:var(--ink)">${country.last.toFixed(2)}%</span>`;
    button.addEventListener('click', () => {
      state.hidden.has(code) ? state.hidden.delete(code) : state.hidden.add(code);
      if (state.hidden.size === ORDER.length) state.hidden.delete(code);
      drawHero();
      drawLegend();
    });
    host.append(button);
  });
}

/* ---------- country panels ---------- */

function sparkline(series) {
  const W = 320;
  const H = 74;
  const box = { l: 1, t: 6, w: W - 2, h: H - 12 };
  const scale = buildScale([series], box);
  const svg = make('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'spark',
    preserveAspectRatio: 'none', role: 'img',
  });
  const rising = series[series.length - 1][1] >= series[0][1];
  const stroke = rising ? 'var(--up)' : 'var(--down)';
  const area = `${pathFor(series, scale)}L${scale.x(series[series.length - 1][0]).toFixed(2)},${H}L${scale.x(series[0][0]).toFixed(2)},${H}Z`;
  svg.append(make('path', { d: area, fill: stroke, opacity: 0.07 }));
  svg.append(
    make('path', {
      d: pathFor(series, scale), fill: 'none', stroke,
      'stroke-width': 1.6, 'stroke-linejoin': 'round',
      'vector-effect': 'non-scaling-stroke',
    })
  );
  return svg;
}

function drawPanels() {
  const grid = el('grid');
  grid.textContent = '';

  // Attach the code before filtering — filtering first would shift the indices.
  const ranked = ORDER.map((code) => ({ code, ...state.data.countries[code] }))
    .filter((c) => c.series)
    .sort((a, b) => b.last - a.last);

  ranked.forEach((country, index) => {
    const series = windowed(country.series, RANGES[state.range]);
    const monthly = country.freq === 'monthly';
    const delta = changes(country.series, monthly);
    const values = series.map(([, v]) => v);

    const panel = document.createElement('article');
    panel.className = 'panel';
    panel.innerHTML = `
      <div class="panel-top">
        <div>
          <span class="rank">${index + 1} of ${ranked.length}</span>
          <h3 class="pname">${country.name}</h3>
          <span class="pbond">${country.bond}</span>
        </div>
        <div class="pyield" style="color:${colour(country.code)}">${country.last.toFixed(2)}<sup>%</sup></div>
      </div>`;

    panel.append(sparkline(series));

    const dl = document.createElement('dl');
    dl.className = 'changes';
    dl.innerHTML = Object.entries(delta)
      .map(([label, value]) => {
        const f = fmtBp(value);
        return `<div class="chg"><dt>${label}</dt><dd class="${f.cls}">${f.text}</dd></div>`;
      })
      .join('');
    panel.append(dl);

    if (country.caveat) {
      const caveat = document.createElement('p');
      caveat.className = 'caveat';
      caveat.textContent = country.caveat;
      panel.append(caveat);
    }

    const range = document.createElement('div');
    range.className = 'range-row';
    range.innerHTML =
      `<span>${state.range} range ${Math.min(...values).toFixed(2)} – ${Math.max(...values).toFixed(2)}%</span>` +
      `<span class="asof">${fmtDate(country.lastDate)}</span>`;
    panel.append(range);

    grid.append(panel);
  });
}

/* ---------- boot ---------- */

function renderAll() {
  drawHero();
  drawLegend();
  drawPanels();
}

async function init() {
  try {
    const response = await fetch(`data/yields.json?v=${Date.now()}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.data = await response.json();
  } catch (error) {
    el('grid').innerHTML =
      `<article class="panel"><h3 class="pname">Yield data didn't load</h3>` +
      `<p class="pbond">${error.message}. The daily update job may not have run yet. ` +
      `Check the Actions tab in the repository.</p></article>`;
    return;
  }

  const missing = ORDER.filter((c) => !state.data.countries[c]);
  const stale = state.data.stale || [];
  if (missing.length || stale.length) {
    const codes = [...new Set([...missing, ...stale])].join(', ');
    el('notice').innerHTML =
      `<h3>Some countries aren't updating</h3><p>No fresh data for ${codes}. ` +
      `See the data sources note below for what each feed needs.</p>`;
    el('notice').hidden = false;
  }

  el('stamp').textContent = `Updated ${new Date(state.data.updated).toLocaleString('en-GB', {
    dateStyle: 'medium', timeStyle: 'short',
  })}`;

  document.querySelectorAll('.ranges button').forEach((button) => {
    button.addEventListener('click', () => {
      state.range = button.dataset.range;
      document.querySelectorAll('.ranges button').forEach((b) => {
        b.setAttribute('aria-pressed', String(b === button));
      });
      renderAll();
    });
  });

  renderAll();
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(drawHero, 150);
  });
}

init();
