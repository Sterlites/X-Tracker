/**
 * Accessible, DOM-constructed SVG trend charts (zero innerHTML).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    node.setAttribute(k, String(v));
  }
  return node;
}

/**
 * Render an SVG sparkline/trend chart for follower or following history.
 * @param {Array<{ at: number, value: number }>} series
 * @param {string} strokeColorCssVar - CSS color or custom property e.g. 'var(--chart-followers)'
 * @param {string} ariaLabel
 * @returns {SVGSVGElement}
 */
export function buildLineChartSvg(series, strokeColorCssVar, ariaLabel) {
  const width = 240;
  const height = 76;
  const pad = 9;
  const svg = svgEl('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': ariaLabel
  });

  if (!Array.isArray(series) || series.length < 2) {
    const text = svgEl('text', {
      x: '50%',
      y: '54%',
      'text-anchor': 'middle',
      fill: 'var(--text-muted)',
      'font-size': '12'
    });
    text.textContent = 'Need 2+ scans';
    svg.appendChild(text);
    return svg;
  }

  const values = series.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(1, max - min);
  const step = (width - pad * 2) / Math.max(1, series.length - 1);

  const coords = series.map((pt, idx) => {
    const x = pad + step * idx;
    const y = height - pad - ((pt.value - min) / range) * (height - pad * 2);
    return [Number(x.toFixed(1)), Number(y.toFixed(1))];
  });

  const pointsAttr = coords.map(([x, y]) => `${x},${y}`).join(' ');
  const areaAttr = `${pad},${height - pad} ${pointsAttr} ${width - pad},${height - pad}`;

  svg.appendChild(
    svgEl('polyline', {
      points: areaAttr,
      fill: strokeColorCssVar,
      opacity: '0.16'
    })
  );
  svg.appendChild(
    svgEl('polyline', {
      points: pointsAttr,
      fill: 'none',
      stroke: strokeColorCssVar,
      'stroke-width': '2.4',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    })
  );

  const [lastX, lastY] = coords[coords.length - 1];
  svg.appendChild(
    svgEl('circle', {
      cx: lastX,
      cy: lastY,
      r: '3.4',
      fill: strokeColorCssVar
    })
  );

  return svg;
}

/**
 * Render a 30-day mirrored gain/loss activity bar chart.
 * @param {Array<{ type: string, at: number }>} events
 * @param {number} days
 * @returns {SVGSVGElement}
 */
export function buildActivityBarsSvg(events, days = 30) {
  const width = 440;
  const height = 76;
  const pad = 8;

  const now = new Date();
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    buckets.push({ day: d.getTime(), gain: 0, loss: 0 });
  }

  const bucketMap = new Map(buckets.map((b) => [b.day, b]));
  for (const ev of events || []) {
    if (!Number.isFinite(ev?.at)) continue;
    const d = new Date(ev.at);
    d.setHours(0, 0, 0, 0);
    const bucket = bucketMap.get(d.getTime());
    if (!bucket) continue;
    if (ev.type === 'followed' || ev.type === 'refollowed') {
      bucket.gain++;
    } else if (ev.type === 'unfollowed' || ev.type === 'reunfollowed') {
      bucket.loss++;
    }
  }

  const totalGains = buckets.reduce((acc, b) => acc + b.gain, 0);
  const totalLosses = buckets.reduce((acc, b) => acc + b.loss, 0);

  const svg = svgEl('svg', {
    class: 'chart-svg',
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `${days}-day activity: ${totalGains} gained, ${totalLosses} lost`
  });

  const mid = Math.round(height / 2);
  svg.appendChild(
    svgEl('line', {
      x1: pad,
      y1: mid,
      x2: width - pad,
      y2: mid,
      stroke: 'var(--border-strong)',
      'stroke-width': '1'
    })
  );

  const maxVal = Math.max(1, ...buckets.map((b) => Math.max(b.gain, b.loss)));
  const slotW = (width - pad * 2) / days;
  const barW = Math.max(3, slotW - 2.5);

  buckets.forEach((bucket, idx) => {
    const x = Number((pad + idx * slotW).toFixed(1));
    if (bucket.gain > 0) {
      const h = Math.max(2, Math.round((bucket.gain / maxVal) * (mid - pad)));
      svg.appendChild(
        svgEl('rect', {
          x,
          y: mid - h,
          width: barW.toFixed(1),
          height: h,
          rx: '1.5',
          fill: 'var(--chart-gain)'
        })
      );
    }
    if (bucket.loss > 0) {
      const h = Math.max(2, Math.round((bucket.loss / maxVal) * (mid - pad)));
      svg.appendChild(
        svgEl('rect', {
          x,
          y: mid,
          width: barW.toFixed(1),
          height: h,
          rx: '1.5',
          fill: 'var(--chart-loss)'
        })
      );
    }
  });

  return svg;
}
