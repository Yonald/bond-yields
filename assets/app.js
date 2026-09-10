/* Sovereign yields — rendering and interaction.
   No build step, no dependencies. Charts are hand-drawn SVG. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const ORDER = ['US', 'DE', 'UK', 'FR', 'CA', 'JP'];
const RANGES = { '1M': 30, '3M': 91, '6M': 182, '1Y': 365, '3Y': 1095 };

const state = {
  data: null,
  range: '1Y',
  maturity: '30Y',
  mode: 'level', // 'level' = absolute yields, 'change' = rebased to zero
  hidden: new Set(),
};

const el = (id) => document.getElementById(id);
const colour = (code) => `var(--${code.toLowerCase()})`;

function make(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/* ---------- data access ----------
   France has no 30Y source at all, so it falls back to its 10Y series and the
   UI flags that rather than hiding it. Everything downstream asks for a series
   through resolve() so the fallback is handled in exactly one place. */

function resolve(code, maturity = state.maturity) {
  const country = state.data.countries[code];
  if (!country) return null;
  const available = country.series[maturity]
    ? maturity
    : country.only && country.series[country.only]
      ? country.only
      : null;
  if (!available) return null;
  return {
    country,
    code,
    actual: available,
    fallback: available !== maturity,
    monthly: country.freq === 'monthly',
    series: country.series[available],
    last: country.last[available],
    lastDate: country.lastDate[available],
  };
}

function windowed(series, days) {
  const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const slice = series.filter(([d]) => d >= cutoff);
  return slice.length > 1 ? slice : series.slice(-2);
}

function asOf(series, targetIso) {
  let found = null;
  for (const [d, v] of series) {
    if (d <= targetIso) found = v;
    else break;
  }
  return found;
}

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

function changes(series, monthly) {
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

function fmtBp(v, withSign = true) {
  if (v == null) return { text: '—', cls: 'flat' };
  const sign = v > 0 ? '+' : v < 0 ? '\u2212' : '';
  return {
    text: `${withSign ? sign : ''}${Math.abs(v)} bp`,
    cls: v > 0 ? 'up' : v < 0 ? 'down' : 'flat',
  };
}

function fmtDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}

/* ---------- scales ---------- */

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
    dates, lo, hi,
    x: (iso) => box.l + ((Date.parse(iso) - t0) / (t1 - t0 || 1)) * box.w,
    y: (v) => box.t + (1 - (v - lo) / (hi - lo || 1)) * box.h,
  };
}

const pathFor = (series, scale) =>
  series
    .map(([d, v], i) => `${i ? 'L' : 'M'}${scale.x(d).toFixed(2)},${scale.y(v).toFixed(2)}`)
    .join('');

// Rebasing to the first point in the window turns "who has high yields"
// (static) into "who is moving" (why you'd open the page daily).
function rebase(series) {
  const base = series[0][1];
  return series.map(([d, v]) => [d, (v - base) * 100]);
}

/* ---------- hero chart ---------- */

function drawHero() {
  const svg = el('hero');
  svg.textContent = '';
  const narrow = window.innerWidth < 700;
  const W = narrow ? 460 : 1000;
  const H = narrow ? 360 : 420;
  const box = { l: narrow ? 38 : 52, t: 16, w: 0, h: H - 16 - 34 };
  box.w = W - box.l - (narrow ? 34 : 58);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const days = RANGES[state.range];
  const visible = ORDER.filter((c) => resolve(c) && !state.hidden.has(c));
  if (!visible.length) return;

  const changeMode = state.mode === 'change';
  const seriesMap = {};
  visible.forEach((code) => {
    const win = windowed(resolve(code).series, days);
    seriesMap[code] = changeMode ? rebase(win) : win;
  });
  const scale = buildScale(Object.values(seriesMap), box);

  niceTicks(scale.lo, scale.hi).forEach((t) => {
    const y = scale.y(t);
    const zero = changeMode && Math.abs(t) < 1e-9;
    svg.append(make('line', {
      x1: box.l, x2: box.l + box.w, y1: y, y2: y,
      stroke: zero ? 'var(--muted)' : 'var(--rule)', 'stroke-width': 1,
    }));
    const label = make('text', {
      x: box.l - 9, y: y + 4, 'text-anchor': 'end',
      fill: 'var(--faint)', 'font-size': 12,
    });
    label.textContent = changeMode ? Math.round(t) : t.toFixed(2);
    svg.append(label);
  });

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

  visible.forEach((code) => {
    const series = seriesMap[code];
    svg.append(make('path', {
      d: pathFor(series, scale), fill: 'none', stroke: colour(code),
      'stroke-width': 1.9, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      ...(resolve(code).monthly ? { 'stroke-dasharray': '5 4' } : {}),
    }));
    const [lastDate, lastVal] = series[series.length - 1];
    svg.append(make('circle', {
      cx: scale.x(lastDate), cy: scale.y(lastVal), r: 3, fill: colour(code),
    }));
  });

  // Nudge end labels apart so close yields stay readable.
  const GAP = 13;
  const tags = visible
    .map((code) => ({ code, y: scale.y(seriesMap[code][seriesMap[code].length - 1][1]) }))
    .sort((a, b) => a.y - b.y);
  for (let i = 1; i < tags.length; i++) {
    if (tags[i].y - tags[i - 1].y < GAP) tags[i].y = tags[i - 1].y + GAP;
  }
  const overflow = tags.length ? tags[tags.length - 1].y - (box.t + box.h) : 0;
  if (overflow > 0) tags.forEach((t) => (t.y -= overflow));

  tags.forEach(({ code, y }) => {
    const anchorY = scale.y(seriesMap[code][seriesMap[code].length - 1][1]);
    if (Math.abs(anchorY - y) > 2) {
      svg.append(make('line', {
        x1: box.l + box.w + 2, x2: box.l + box.w + 6, y1: anchorY, y2: y,
        stroke: colour(code), 'stroke-width': 1, opacity: 0.55,
      }));
    }
    const tag = make('text', {
      x: box.l + box.w + 9, y: y + 4,
      fill: colour(code), 'font-size': 12, 'font-weight': 600,
    });
    tag.textContent = code;
    svg.append(tag);
  });

  const crosshair = make('line', {
    y1: box.t, y2: box.t + box.h, stroke: 'var(--ink)', 'stroke-width': 1,
    'stroke-dasharray': '3 3', opacity: 0,
  });
  svg.append(crosshair);
  attachTooltip(svg, box, scale, seriesMap, visible, crosshair, changeMode);

  el('yaxis').textContent = changeMode
    ? `Change in basis points since ${fmtDate(scale.dates[0])}`
    : `Yield, per cent`;
}

/* ---------- tooltip ---------- */

function attachTooltip(svg, box, scale, seriesMap, visible, crosshair, changeMode) {
  const tip = el('tip');

  const move = (event) => {
    const rect = svg.getBoundingClientRect();
    const vbScale = rect.width / svg.viewBox.baseVal.width;
    const point = event.touches ? event.touches[0] : event;
    const localX = (point.clientX - rect.left) / vbScale;
    if (localX < box.l - 4 || localX > box.l + box.w + 4) return hide();

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
        const shown = changeMode
          ? `${value > 0 ? '+' : value < 0 ? '\u2212' : ''}${Math.abs(Math.round(value))} bp`
          : `${value.toFixed(2)}%`;
        return `<div class="trow"><span style="color:${colour(code)}">${code}</span><b>${shown}</b></div>`;
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
    const info = resolve(code);
    if (!info) return;
    const shown = !state.hidden.has(code);
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(shown));
    button.style.color = colour(code);
    button.innerHTML =
      `<span class="swatch"></span>` +
      `<span class="lname" style="color:var(--ink)">${info.country.name}</span>` +
      `<span class="lval" style="color:var(--ink)">${info.last.toFixed(2)}%</span>` +
      (info.fallback ? `<span class="lflag">${info.actual}</span>` : '');
    button.addEventListener('click', () => {
      state.hidden.has(code) ? state.hidden.delete(code) : state.hidden.add(code);
      if (state.hidden.size === ORDER.length) state.hidden.delete(code);
      drawHero();
      drawLegend();
    });
    host.append(button);
  });
}

/* ---------- panels ---------- */

function sparkline(series) {
  const W = 320;
  const H = 74;
  const box = { l: 1, t: 6, w: W - 2, h: H - 12 };
  const scale = buildScale([series], box);
  const svg = make('svg', {
    viewBox: `0 0 ${W} ${H}`, class: 'spark',
    preserveAspectRatio: 'none', role: 'img',
  });
  // Neutral ink: the coloured change figures below already carry direction,
  // and over a year every line is red, so the colour carried no information.
  svg.append(make('path', {
    d: pathFor(series, scale), fill: 'none', stroke: 'var(--muted)',
    'stroke-width': 1.5, 'stroke-linejoin': 'round',
    'vector-effect': 'non-scaling-stroke',
  }));
  return svg;
}

// Where today sits inside the window's range, as a bar rather than arithmetic.
function rangeBar(values, current) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pct = hi === lo ? 50 : ((current - lo) / (hi - lo)) * 100;

  const wrap = document.createElement('div');
  wrap.className = 'rangebar';
  wrap.innerHTML =
    `<span class="rb-end">${lo.toFixed(2)}</span>` +
    `<span class="rb-track"><span class="rb-marker" style="left:${pct.toFixed(1)}%"></span></span>` +
    `<span class="rb-end">${hi.toFixed(2)}</span>`;
  wrap.title = `${state.range} range: ${lo.toFixed(2)}% to ${hi.toFixed(2)}%, now ${current.toFixed(2)}%`;
  return wrap;
}

function drawPanels() {
  const grid = el('grid');
  grid.textContent = '';

  const ranked = ORDER.map((code) => resolve(code))
    .filter(Boolean)
    .sort((a, b) => b.last - a.last);

  ranked.forEach((info) => {
    // Compare like with like: France's 10Y fallback is spread against Bunds
    // at 10Y, not against the 30Y Bund.
    const anchor = resolve(state.data.anchor || 'DE', info.actual);
    const spread =
      anchor && info.code !== anchor.code
        ? Math.round((info.last - anchor.last) * 100)
        : null;

    const series = windowed(info.series, RANGES[state.range]);
    const delta = changes(info.series, info.monthly);
    const values = series.map(([, v]) => v);

    const panel = document.createElement('article');
    panel.className = 'panel';
    const label = info.monthly
      ? `${info.actual} · monthly average`
      : `${info.actual} ${info.country.bond}`;
    panel.innerHTML = `
      <div class="panel-top">
        <div>
          <h3 class="pname">${info.country.name}</h3>
          <span class="pbond">${label}</span>
        </div>
        <div class="pyield" style="color:${colour(info.code)}">${info.last.toFixed(2)}<sup>%</sup></div>
      </div>`;

    panel.append(sparkline(series));

    const dl = document.createElement('dl');
    dl.className = 'changes';
    dl.innerHTML = Object.entries(delta)
      .map(([name, value]) => {
        const f = fmtBp(value);
        return `<div class="chg"><dt>${name}</dt><dd class="${f.cls}">${f.text}</dd></div>`;
      })
      .join('');
    panel.append(dl);

    const spreadRow = document.createElement('div');
    spreadRow.className = 'spread';
    if (info.code === (state.data.anchor || 'DE')) {
      spreadRow.innerHTML = `<span>Spread benchmark</span><b class="flat">anchor</b>`;
    } else {
      const f = fmtBp(spread);
      spreadRow.innerHTML =
        `<span>vs ${info.actual} Bund</span><b class="${f.cls}">${f.text}</b>`;
    }
    panel.append(spreadRow);

    panel.append(rangeBar(values, info.last));

    if (info.country.caveat) {
      const caveat = document.createElement('p');
      caveat.className = 'caveat';
      caveat.textContent = info.country.caveat;
      panel.append(caveat);
    }

    const foot = document.createElement('div');
    foot.className = 'asof';
    foot.textContent = fmtDate(info.lastDate);
    panel.append(foot);

    grid.append(panel);
  });
}

/* ---------- boot ---------- */

function renderAll() {
  drawHero();
  drawLegend();
  drawPanels();
}

function wireToggle(selector, key, after) {
  document.querySelectorAll(selector).forEach((button) => {
    button.addEventListener('click', () => {
      state[key] = button.dataset[key];
      document.querySelectorAll(selector).forEach((b) => {
        b.setAttribute('aria-pressed', String(b === button));
      });
      if (after) after();
      renderAll();
    });
  });
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

  const stale = state.data.stale || [];
  const missing = ORDER.filter((c) => !state.data.countries[c]);
  if (missing.length || stale.length) {
    const codes = [...new Set([...missing, ...stale])].join(', ');
    el('notice').innerHTML =
      `<h3>Some countries aren't updating</h3><p>No fresh data for ${codes}. ` +
      `See the data sources note below.</p>`;
    el('notice').hidden = false;
  }

  el('stamp').textContent = `Updated ${new Date(state.data.updated).toLocaleString('en-GB', {
    dateStyle: 'medium', timeStyle: 'short',
  })}`;

  wireToggle('.maturities button', 'maturity');
  wireToggle('.ranges button', 'range');
  wireToggle('.modes button', 'mode');

  renderAll();
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(drawHero, 150);
  });
}

init();
