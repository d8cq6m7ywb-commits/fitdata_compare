// analyzer.js — FIT File Sensor Comparison Tool v2.1

// ═══════════════════════════════════════════════════════════════
// GLOBALS
// ═══════════════════════════════════════════════════════════════

let parsedFiles = { A: null, B: null, C: null };
let aligned = null;
let deviceLabels = { A: "Device A", B: "Device B", C: "Device C" };
let manualOffsets = { B: 0, C: 0 };
let smoothingWindow = 1; // 1 = raw, 5/10/30 = rolling average seconds
let speedMode = "speed"; // "speed" or "pace"

const DEVICE_COLORS = {
  A: { border: "#22c55e", bg: "rgba(34,197,94,0.15)" },
  B: { border: "#3b82f6", bg: "rgba(59,130,246,0.15)" },
  C: { border: "#f59e0b", bg: "rgba(245,158,11,0.15)" }
};
const DIFF_COLORS = {
  BA: { border: "#8b5cf6", bg: "rgba(139,92,246,0.15)" },
  CA: { border: "#ef4444", bg: "rgba(239,68,68,0.15)" }
};

const metricCharts = {};
const diffCharts = {};
let pdcChart = null;
let elevChart = null;
let leafletMap = null;
let mapLayers = [];

// Global zoom state for synchronized zooming
let globalZoom = { min: undefined, max: undefined };

const METRICS = [
  { key: "power", label: "Power", unit: "W", canvas: "powerChart", diffCanvas: "powerDiffChart" },
  { key: "heartRate", label: "Heart Rate", unit: "bpm", canvas: "hrChart", diffCanvas: "hrDiffChart" },
  { key: "cadence", label: "Cadence", unit: "rpm", canvas: "cadenceChart", diffCanvas: "cadenceDiffChart" },
  { key: "speed", label: "Speed", unit: "km/h", canvas: "speedChart", diffCanvas: "speedDiffChart" }
];

// ═══════════════════════════════════════════════════════════════
// 1. FIT PARSING
// ═══════════════════════════════════════════════════════════════

async function parseFitFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        if (!window.FitEntry || typeof window.FitEntry.parseFitToTimeSeries !== "function") {
          reject(new Error("FIT parser not loaded"));
          return;
        }
        Promise.resolve(window.FitEntry.parseFitToTimeSeries(e.target.result))
          .then(resolve).catch(reject);
      } catch (err) { reject(err); }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ═══════════════════════════════════════════════════════════════
// 2. ROLLING AVERAGE
// ═══════════════════════════════════════════════════════════════

function rollingAverage(series, windowSec) {
  if (!Array.isArray(series) || windowSec <= 1) return series;
  const out = new Array(series.length).fill(null);
  let sum = 0, count = 0;
  for (let i = 0; i < series.length; i++) {
    if (series[i] != null) { sum += series[i]; count++; }
    if (i >= windowSec) {
      if (series[i - windowSec] != null) { sum -= series[i - windowSec]; count--; }
    }
    out[i] = count > 0 ? sum / count : null;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// 3. SPEED / PACE CONVERSION
// ═══════════════════════════════════════════════════════════════

// Speed stored in aligned data as m/s (raw). Convert at display time.
function msToKmh(v) { return v != null ? v * 3.6 : null; }
function msToMinPerKm(v) {
  if (v == null || v <= 0.3) return null; // below ~1 km/h, pace is meaningless
  return 60 / (v * 3.6); // min/km
}

function formatPace(minPerKm) {
  if (minPerKm == null || !Number.isFinite(minPerKm) || minPerKm > 30) return "—";
  const mins = Math.floor(minPerKm);
  const secs = Math.round((minPerKm - mins) * 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function getSpeedDisplaySeries(series) {
  if (!Array.isArray(series)) return null;
  if (speedMode === "pace") return series.map(msToMinPerKm);
  return series.map(msToKmh);
}

function getSpeedUnit() { return speedMode === "pace" ? "min/km" : "km/h"; }
function getSpeedLabel() { return speedMode === "pace" ? "Pace" : "Speed"; }

// ═══════════════════════════════════════════════════════════════
// 4. TIME ALIGNMENT
// ═══════════════════════════════════════════════════════════════

function estimateOffsetByCrossCorrelation(baseTs, baseSeries, otherTs, otherSeries, maxLagSec) {
  const bValid = baseTs.filter(t => t != null);
  const oValid = otherTs.filter(t => t != null);
  if (!bValid.length || !oValid.length) return 0;

  const bStart = bValid[0];
  const oStart = oValid[0];

  // Use linear interpolation for smart recording compatibility
  function toGrid(ts, series, start, duration) {
    const out = new Float64Array(duration).fill(0);
    let idx = 0;
    for (let s = 0; s < duration; s++) {
      const target = start + s;
      // Advance idx to bracket the target
      while (idx + 1 < ts.length && ts[idx + 1] < target) idx++;

      if (ts[idx] == null) continue;
      const v0 = series[idx];
      if (v0 == null) continue;

      // Check if we can interpolate
      if (idx + 1 < ts.length && ts[idx + 1] != null && series[idx + 1] != null) {
        const t0 = ts[idx], t1 = ts[idx + 1];
        const gap = t1 - t0;
        // Only interpolate within reasonable gaps (< 10s, skip pauses)
        if (gap > 0 && gap < 10 && target >= t0 && target <= t1) {
          const frac = (target - t0) / gap;
          out[s] = v0 + frac * (series[idx + 1] - v0);
          continue;
        }
      }
      // Fall back to nearest-neighbor with tolerance
      if (Math.abs(ts[idx] - target) <= 3) {
        out[s] = v0;
      }
    }
    return out;
  }

  const bDur = Math.min(3600, Math.ceil(bValid[bValid.length - 1] - bStart));
  const oDur = Math.min(3600, Math.ceil(oValid[oValid.length - 1] - oStart));
  if (bDur < 30 || oDur < 30) return 0;

  const bGrid = toGrid(baseTs, baseSeries, bStart, bDur);
  const oGrid = toGrid(otherTs, otherSeries, oStart, oDur);

  // Mean-center
  const bMean = bGrid.reduce((a, b) => a + b, 0) / bGrid.length;
  const oMean = oGrid.reduce((a, b) => a + b, 0) / oGrid.length;
  for (let i = 0; i < bGrid.length; i++) bGrid[i] -= bMean;
  for (let i = 0; i < oGrid.length; i++) oGrid[i] -= oMean;

  let bestCorr = -Infinity;
  let bestLag = 0;
  const minLen = Math.min(bGrid.length, oGrid.length);

  for (let lag = -maxLagSec; lag <= maxLagSec; lag++) {
    let sum = 0, count = 0;
    for (let i = 0; i < minLen; i++) {
      const j = i + lag;
      if (j < 0 || j >= oGrid.length) continue;
      sum += bGrid[i] * oGrid[j];
      count++;
    }
    if (count > 0 && sum > bestCorr) {
      bestCorr = sum;
      bestLag = lag;
    }
  }

  return (bStart - oStart) + bestLag;
}

function alignTimeSeries(dataA, dataB, dataC, dtSec, offsetB, offsetC) {
  if (!dataA || !dataB) throw new Error("Need at least files A and B");
  const tA = dataA.timestamps.filter(t => t != null);
  const tB = dataB.timestamps.filter(t => t != null);
  if (!tA.length || !tB.length) throw new Error("Missing timestamps");

  const tB_adj = dataB.timestamps.map(t => t != null ? t + offsetB : null);
  const tC_adj = dataC ? dataC.timestamps.map(t => t != null ? t + offsetC : null) : [];

  const allStarts = [tA[0], tB_adj.find(t => t != null)];
  const allEnds = [tA[tA.length - 1], tB_adj.filter(t => t != null).pop()];

  if (dataC && tC_adj.length) {
    const cValid = tC_adj.filter(t => t != null);
    if (cValid.length) {
      allStarts.push(cValid[0]);
      allEnds.push(cValid[cValid.length - 1]);
    }
  }

  const tStart = Math.max(...allStarts.filter(t => t != null));
  const tEnd = Math.min(...allEnds.filter(t => t != null));

  if (!Number.isFinite(tStart) || !Number.isFinite(tEnd) || tEnd <= tStart) {
    throw new Error("No overlapping time range between files.");
  }

  const times = [];
  for (let t = tStart; t <= tEnd; t += dtSec) times.push(t);

  function resample(timestamps, series) {
    if (!Array.isArray(timestamps) || !Array.isArray(series)) return null;
    const out = new Array(times.length).fill(null);
    let idx = 0;
    for (let j = 0; j < times.length; j++) {
      const target = times[j];
      while (idx + 1 < timestamps.length &&
        Math.abs(timestamps[idx + 1] - target) < Math.abs(timestamps[idx] - target)) {
        idx++;
      }
      if (timestamps[idx] != null && Math.abs(timestamps[idx] - target) <= dtSec) {
        out[j] = series[idx];
      }
    }
    return out;
  }

  // Keep speed in raw m/s — convert at display time only
  const fields = ["power", "heartRate", "speed", "cadence", "altitude"];
  const result = { times, A: {}, B: {}, C: {} };

  for (const f of fields) {
    result.A[f] = resample(dataA.timestamps, dataA[f]);
    result.B[f] = resample(tB_adj, dataB[f]);
    if (dataC) {
      result.C[f] = resample(tC_adj, dataC[f]);
    } else {
      result.C[f] = null;
    }
  }

  // Collect all pauses for visualization
  const allPauses = [];
  function collectPauses(parsed, label, offset) {
    if (!parsed || !parsed.pauses) return;
    for (const p of parsed.pauses) {
      const s = p.startTime + (offset || 0);
      const e = p.endTime + (offset || 0);
      if (e >= tStart && s <= tEnd) {
        allPauses.push({ start: Math.max(s, tStart), end: Math.min(e, tEnd), device: label, gapSec: p.gapSec });
      }
    }
  }
  collectPauses(dataA, "A", 0);
  collectPauses(dataB, "B", offsetB);
  if (dataC) collectPauses(dataC, "C", offsetC);
  result.pauses = allPauses;

  return result;
}

// ═══════════════════════════════════════════════════════════════
// 5. STATISTICS
// ═══════════════════════════════════════════════════════════════

function basicStats(series, metricKey) {
  if (!Array.isArray(series)) return null;
  let count = 0, sum = 0, min = Infinity, max = -Infinity;
  let zeroCount = 0, dropoutCount = 0;
  const values = [];

  for (const v of series) {
    if (v == null) { dropoutCount++; continue; }
    if (metricKey === "heartRate" && v === 0) { dropoutCount++; continue; }
    values.push(v);
    count++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v === 0 && metricKey !== "heartRate") zeroCount++;
  }

  if (!count) return { count: 0, mean: null, min: null, max: null, std: null, zeroCount, zeroPct: 0, dropoutCount, dropoutPct: series.length ? (dropoutCount / series.length) * 100 : 0 };

  const mean = sum / count;
  let s2 = 0;
  for (const v of values) s2 += (v - mean) ** 2;
  const std = Math.sqrt(s2 / Math.max(1, count - 1));

  return { count, mean, min, max, std, zeroCount, zeroPct: (zeroCount / count) * 100, dropoutCount, dropoutPct: (dropoutCount / series.length) * 100 };
}

function pairwiseComparison(base, other, metricKey) {
  if (!Array.isArray(base) || !Array.isArray(other)) return null;

  let diffSum = 0, absDiffSum = 0, sqDiffSum = 0, relDiffSum = 0;
  let diffCount = 0;
  const diffs = [];
  let sumXY = 0, sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, corrN = 0;
  let sumT = 0, sumD = 0, sumTD = 0, sumT2 = 0, driftN = 0;

  for (let i = 0; i < base.length; i++) {
    const a = base[i], b = other[i];
    if (a == null || b == null) continue;
    if (metricKey === "heartRate" && (a === 0 || b === 0)) continue;

    const diff = b - a;
    diffs.push(diff);
    diffSum += diff;
    absDiffSum += Math.abs(diff);
    sqDiffSum += diff * diff;
    diffCount++;

    if (a !== 0) relDiffSum += diff / a;

    sumXY += a * b;
    sumX += a; sumY += b;
    sumX2 += a * a; sumY2 += b * b;
    corrN++;

    sumT += i; sumD += diff;
    sumTD += i * diff; sumT2 += i * i;
    driftN++;
  }

  if (!diffCount) return null;

  const meanDiff = diffSum / diffCount;
  const mae = absDiffSum / diffCount;
  const rmse = Math.sqrt(sqDiffSum / diffCount);
  const meanRelPct = (relDiffSum / diffCount) * 100;

  let correlation = null;
  if (corrN > 2) {
    const num = corrN * sumXY - sumX * sumY;
    const den = Math.sqrt((corrN * sumX2 - sumX * sumX) * (corrN * sumY2 - sumY * sumY));
    correlation = den > 0 ? num / den : null;
  }

  let driftPerMinute = null;
  if (driftN > 10) {
    const slope = (driftN * sumTD - sumT * sumD) / (driftN * sumT2 - sumT * sumT);
    driftPerMinute = slope * 60;
  }

  let dropoutRuns = 0, inDropout = false;
  for (let i = 0; i < other.length; i++) {
    if (other[i] == null) { if (!inDropout) { dropoutRuns++; inDropout = true; } } else { inDropout = false; }
  }

  const pattern = classifyDisagreement(meanDiff, mae, rmse, correlation, driftPerMinute, dropoutRuns, diffs, metricKey);

  return { meanDiff, mae, rmse, meanRelPct, correlation, driftPerMinute, dropoutRuns, sampleCount: diffCount, pattern };
}

function classifyDisagreement(meanDiff, mae, rmse, corr, driftPerMin, dropoutRuns, diffs, metricKey) {
  const issues = [];

  const thresholds = {
    power: { offset: 5, drift: 0.3, smoothRatio: 1.5 },
    heartRate: { offset: 3, drift: 0.2, smoothRatio: 1.3 },
    cadence: { offset: 3, drift: 0.2, smoothRatio: 1.3 },
    speed: { offset: 0.3, drift: 0.05, smoothRatio: 1.3 }
  };
  const th = thresholds[metricKey] || thresholds.power;

  if (Math.abs(meanDiff) > th.offset) {
    const dir = meanDiff > 0 ? "higher" : "lower";
    const unitLabel = metricKey === "speed" ? "m/s" : getUnit(metricKey);
    issues.push({ type: "offset", severity: Math.abs(meanDiff) > th.offset * 3 ? "high" : "moderate", desc: `Consistent ${dir} by ~${Math.abs(meanDiff).toFixed(1)} ${unitLabel}` });
  }

  if (driftPerMin != null && Math.abs(driftPerMin) > th.drift) {
    const dir = driftPerMin > 0 ? "increasing" : "decreasing";
    issues.push({ type: "drift", severity: Math.abs(driftPerMin) > th.drift * 3 ? "high" : "moderate", desc: `Drift ${dir} at ~${Math.abs(driftPerMin).toFixed(2)}/min` });
  }

  if (dropoutRuns > 3) {
    issues.push({ type: "dropout", severity: dropoutRuns > 10 ? "high" : "moderate", desc: `${dropoutRuns} dropout segments detected` });
  }

  if (mae > 0 && rmse / mae > th.smoothRatio) {
    issues.push({ type: "smoothing", severity: "low", desc: "One source appears smoother/more averaged" });
  }

  if (corr != null && corr < 0.95) {
    issues.push({ type: "correlation", severity: corr < 0.8 ? "high" : "moderate", desc: `Weak correlation (r=${corr.toFixed(3)})` });
  }

  if (issues.length === 0) {
    issues.push({ type: "ok", severity: "none", desc: "Good agreement" });
  }

  return issues;
}

function getUnit(metricKey) {
  const units = { power: "W", heartRate: "bpm", cadence: "rpm", speed: "km/h", altitude: "m" };
  return units[metricKey] || "";
}

// ═══════════════════════════════════════════════════════════════
// 6. TIME FORMATTING
// ═══════════════════════════════════════════════════════════════

function formatElapsed(seconds) {
  if (!Number.isFinite(seconds)) return "";
  const totalSec = Math.round(seconds);
  if (totalSec < 90) return `${totalSec}s`;
  const totalMin = Math.round(totalSec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${totalMin}m`;
  return `${h}h${m.toString().padStart(2, "0")}`;
}

function formatMinutes(minutes) {
  return formatElapsed(minutes * 60);
}

// ═══════════════════════════════════════════════════════════════
// 7. CHART HELPERS
// ═══════════════════════════════════════════════════════════════

function makeTimeAxis() {
  return {
    title: { display: true, text: "Elapsed Time", color: "#9ca3af" },
    ticks: {
      color: "#9ca3af",
      callback(value) {
        const raw = this.getLabelForValue ? this.getLabelForValue(value) : value;
        return formatMinutes(Number(raw));
      }
    },
    grid: { color: "rgba(148,163,184,0.12)" }
  };
}

function makeYAxis(label) {
  return {
    title: { display: true, text: label, color: "#9ca3af" },
    ticks: { color: "#9ca3af" },
    grid: { color: "rgba(148,163,184,0.12)" }
  };
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: "nearest", intersect: false },
    plugins: {
      legend: {
        labels: {
          color: "#e5e7eb",
          usePointStyle: true,
          pointStyleWidth: 16,
          padding: 12,
          filter: (item) => item.text !== "Zero" // Hide zero reference line from legend
        }
      },
      tooltip: { mode: "index", intersect: false }
    },
    animation: { duration: 300 }
  };
}

// ─── Synchronized drag-zoom ───

function syncZoomToAll(min, max) {
  globalZoom.min = min;
  globalZoom.max = max;

  const allCharts = [
    ...Object.values(metricCharts),
    ...Object.values(diffCharts),
    elevChart
  ].filter(Boolean);

  for (const chart of allCharts) {
    chart.options.scales.x.min = min;
    chart.options.scales.x.max = max;
    chart.update("none");
  }
}

function attachDragZoom(chart) {
  const canvas = chart.canvas;
  let isDragging = false, dragStartX = null;
  let overlay = null;

  canvas.addEventListener("mousedown", (ev) => {
    isDragging = true;
    dragStartX = ev.clientX - canvas.getBoundingClientRect().left;
    overlay = document.createElement("div");
    overlay.className = "zoom-overlay";
    overlay.style.left = dragStartX + "px";
    overlay.style.width = "0px";
    canvas.parentElement.style.position = "relative";
    canvas.parentElement.appendChild(overlay);
  });

  canvas.addEventListener("mousemove", (ev) => {
    if (!isDragging || !overlay) return;
    const rect = canvas.getBoundingClientRect();
    const currentX = ev.clientX - rect.left;
    const left = Math.min(dragStartX, currentX);
    const width = Math.abs(currentX - dragStartX);
    overlay.style.left = left + "px";
    overlay.style.width = width + "px";
    overlay.style.top = "0px";
    overlay.style.height = canvas.offsetHeight + "px";
  });

  canvas.addEventListener("mouseup", (ev) => {
    if (!isDragging) return;
    isDragging = false;
    if (overlay) { overlay.remove(); overlay = null; }

    const rect = canvas.getBoundingClientRect();
    const dragEndX = ev.clientX - rect.left;
    if (Math.abs(dragEndX - dragStartX) < 5) return;

    const xScale = chart.scales.x;
    const from = Math.min(dragStartX, dragEndX);
    const to = Math.max(dragStartX, dragEndX);
    const minVal = xScale.getValueForPixel(from);
    const maxVal = xScale.getValueForPixel(to);

    // Sync all charts
    syncZoomToAll(minVal, maxVal);
  });

  canvas.addEventListener("mouseleave", () => {
    if (overlay) { overlay.remove(); overlay = null; }
    isDragging = false;
  });

  canvas.addEventListener("dblclick", () => {
    syncZoomToAll(undefined, undefined);
  });
}

// ═══════════════════════════════════════════════════════════════
// 8. METRIC OVERLAY CHARTS
// ═══════════════════════════════════════════════════════════════

function getDisplaySeries(data, metricKey, deviceKey) {
  let series = data[deviceKey][metricKey];
  if (!Array.isArray(series)) return null;

  // Convert speed at display time
  if (metricKey === "speed") {
    series = getSpeedDisplaySeries(series);
  }

  // Apply smoothing
  return rollingAverage(series, smoothingWindow);
}

function renderMetricChart(data, metricDef) {
  const canvas = document.getElementById(metricDef.canvas);
  if (!canvas) return;

  const serA = getDisplaySeries(data, metricDef.key, "A");
  const serB = getDisplaySeries(data, metricDef.key, "B");
  const serC = getDisplaySeries(data, metricDef.key, "C");

  const hasA = Array.isArray(serA) && serA.some(v => v != null);
  const hasB = Array.isArray(serB) && serB.some(v => v != null);
  const hasC = Array.isArray(serC) && serC.some(v => v != null);

  if (!hasA && !hasB && !hasC) {
    if (metricCharts[metricDef.key]) { metricCharts[metricDef.key].destroy(); metricCharts[metricDef.key] = null; }
    canvas.closest(".chart-card").style.display = "none";
    return;
  }
  canvas.closest(".chart-card").style.display = "";

  const t0 = data.times[0];
  const labels = data.times.map(t => (t - t0) / 60);
  const datasets = [];

  if (hasA) datasets.push({ label: deviceLabels.A, data: serA, borderColor: DEVICE_COLORS.A.border, backgroundColor: DEVICE_COLORS.A.bg, spanGaps: true, borderWidth: 1.5, pointRadius: 0, pointHitRadius: 4, fill: false });
  if (hasB) datasets.push({ label: deviceLabels.B, data: serB, borderColor: DEVICE_COLORS.B.border, backgroundColor: DEVICE_COLORS.B.bg, spanGaps: true, borderWidth: 1.5, pointRadius: 0, pointHitRadius: 4, fill: false });
  if (hasC) datasets.push({ label: deviceLabels.C, data: serC, borderColor: DEVICE_COLORS.C.border, backgroundColor: DEVICE_COLORS.C.bg, spanGaps: true, borderWidth: 1.5, pointRadius: 0, pointHitRadius: 4, fill: false });

  if (metricCharts[metricDef.key]) metricCharts[metricDef.key].destroy();

  const isSpeed = metricDef.key === "speed";
  const yLabel = isSpeed ? `${getSpeedLabel()} (${getSpeedUnit()})` : `${metricDef.label} (${metricDef.unit})`;
  const yAxis = makeYAxis(yLabel);

  // For pace mode, reverse the Y axis (lower = faster)
  if (isSpeed && speedMode === "pace") {
    yAxis.reverse = true;
    yAxis.ticks = {
      ...yAxis.ticks,
      callback(value) { return formatPace(value); }
    };
  }

  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      ...chartDefaults(),
      scales: {
        x: { ...makeTimeAxis(), min: globalZoom.min, max: globalZoom.max },
        y: yAxis
      }
    }
  });

  metricCharts[metricDef.key] = chart;
  attachDragZoom(chart);
}

// ═══════════════════════════════════════════════════════════════
// 9. DIFFERENCE CHARTS
// ═══════════════════════════════════════════════════════════════

function renderDiffChart(data, metricDef) {
  const canvas = document.getElementById(metricDef.diffCanvas);
  if (!canvas) return;

  const serA = getDisplaySeries(data, metricDef.key, "A");
  const serB = getDisplaySeries(data, metricDef.key, "B");
  const serC = getDisplaySeries(data, metricDef.key, "C");

  const hasBA = Array.isArray(serA) && Array.isArray(serB);
  const hasCA = Array.isArray(serA) && Array.isArray(serC);

  if (!hasBA && !hasCA) {
    if (diffCharts[metricDef.key]) { diffCharts[metricDef.key].destroy(); diffCharts[metricDef.key] = null; }
    canvas.closest(".chart-card").style.display = "none";
    return;
  }
  canvas.closest(".chart-card").style.display = "";

  const t0 = data.times[0];
  const labels = data.times.map(t => (t - t0) / 60);
  const datasets = [];

  if (hasBA) {
    const diffBA = serA.map((a, i) => (a != null && serB[i] != null) ? serB[i] - a : null);
    datasets.push({
      label: `${deviceLabels.B} − ${deviceLabels.A}`,
      data: diffBA,
      borderColor: DIFF_COLORS.BA.border,
      backgroundColor: DIFF_COLORS.BA.bg,
      spanGaps: true, borderWidth: 1.5, pointRadius: 0, fill: true
    });
  }

  if (hasCA) {
    const diffCA = serA.map((a, i) => (a != null && serC[i] != null) ? serC[i] - a : null);
    datasets.push({
      label: `${deviceLabels.C} − ${deviceLabels.A}`,
      data: diffCA,
      borderColor: DIFF_COLORS.CA.border,
      backgroundColor: DIFF_COLORS.CA.bg,
      spanGaps: true, borderWidth: 1.5, pointRadius: 0, fill: true
    });
  }

  // Zero reference line — hidden from legend via filter callback
  datasets.push({
    label: "Zero",
    data: new Array(labels.length).fill(0),
    borderColor: "rgba(148,163,184,0.4)",
    borderWidth: 1, borderDash: [4, 4],
    pointRadius: 0, fill: false
  });

  if (diffCharts[metricDef.key]) diffCharts[metricDef.key].destroy();

  const isSpeed = metricDef.key === "speed";
  const unit = isSpeed ? getSpeedUnit() : metricDef.unit;

  const chart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      ...chartDefaults(),
      scales: {
        x: { ...makeTimeAxis(), min: globalZoom.min, max: globalZoom.max },
        y: makeYAxis(`Difference (${unit})`)
      }
    }
  });

  diffCharts[metricDef.key] = chart;
  attachDragZoom(chart);
}

// ═══════════════════════════════════════════════════════════════
// 10. ELEVATION CHART
// ═══════════════════════════════════════════════════════════════

function renderElevationChart(data) {
  const canvas = document.getElementById("elevChart");
  if (!canvas) return;

  const getElev = (devKey) => {
    let s = data[devKey].altitude;
    if (!Array.isArray(s)) return null;
    return rollingAverage(s, smoothingWindow);
  };

  const serA = getElev("A"), serB = getElev("B"), serC = getElev("C");
  const hasA = Array.isArray(serA) && serA.some(v => v != null);
  const hasB = Array.isArray(serB) && serB.some(v => v != null);
  const hasC = Array.isArray(serC) && serC.some(v => v != null);

  if (!hasA && !hasB && !hasC) {
    canvas.closest(".chart-card").style.display = "none";
    return;
  }
  canvas.closest(".chart-card").style.display = "";

  const t0 = data.times[0];
  const labels = data.times.map(t => (t - t0) / 60);
  const datasets = [];

  if (hasA) datasets.push({ label: deviceLabels.A, data: serA, borderColor: DEVICE_COLORS.A.border, backgroundColor: DEVICE_COLORS.A.bg, spanGaps: true, borderWidth: 1.5, pointRadius: 0, fill: true });
  if (hasB) datasets.push({ label: deviceLabels.B, data: serB, borderColor: DEVICE_COLORS.B.border, backgroundColor: DEVICE_COLORS.B.bg, spanGaps: true, borderWidth: 1.5, pointRadius: 0, fill: false });
  if (hasC) datasets.push({ label: deviceLabels.C, data: serC, borderColor: DEVICE_COLORS.C.border, backgroundColor: DEVICE_COLORS.C.bg, spanGaps: true, borderWidth: 1.5, pointRadius: 0, fill: false });

  if (elevChart) elevChart.destroy();

  elevChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels, datasets },
    options: {
      ...chartDefaults(),
      scales: {
        x: { ...makeTimeAxis(), min: globalZoom.min, max: globalZoom.max },
        y: makeYAxis("Elevation (m)")
      }
    }
  });

  attachDragZoom(elevChart);
}

// ═══════════════════════════════════════════════════════════════
// 11. POWER DURATION CURVE
// ═══════════════════════════════════════════════════════════════

function computePDC(series, durationsSec) {
  if (!Array.isArray(series)) return null;
  const clean = series.map(v => v == null ? 0 : v);
  if (!clean.length) return null;

  return durationsSec.map(dur => {
    const w = Math.max(1, Math.round(dur));
    if (w > clean.length) return null;
    let sum = 0;
    for (let i = 0; i < w; i++) sum += clean[i];
    let maxAvg = sum / w;
    for (let i = w; i < clean.length; i++) {
      sum += clean[i] - clean[i - w];
      const avg = sum / w;
      if (avg > maxAvg) maxAvg = avg;
    }
    return maxAvg;
  });
}

function renderPDC(data) {
  const canvas = document.getElementById("pdcChart");
  if (!canvas) return;

  const durationsSec = [1, 5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 300, 420, 600, 900, 1200, 1800, 3600];
  const labelsMin = durationsSec.map(d => d / 60);

  const pdcA = computePDC(data.A.power, durationsSec);
  const pdcB = computePDC(data.B.power, durationsSec);
  const pdcC = data.C.power ? computePDC(data.C.power, durationsSec) : null;

  if (!pdcA && !pdcB && !pdcC) {
    canvas.closest(".chart-card").style.display = "none";
    return;
  }
  canvas.closest(".chart-card").style.display = "";

  const datasets = [];
  if (pdcA) datasets.push({ label: deviceLabels.A, data: pdcA, borderColor: DEVICE_COLORS.A.border, borderWidth: 2, pointRadius: 3, pointBackgroundColor: DEVICE_COLORS.A.border, fill: false });
  if (pdcB) datasets.push({ label: deviceLabels.B, data: pdcB, borderColor: DEVICE_COLORS.B.border, borderWidth: 2, pointRadius: 3, pointBackgroundColor: DEVICE_COLORS.B.border, fill: false });
  if (pdcC) datasets.push({ label: deviceLabels.C, data: pdcC, borderColor: DEVICE_COLORS.C.border, borderWidth: 2, pointRadius: 3, pointBackgroundColor: DEVICE_COLORS.C.border, fill: false });

  if (pdcChart) pdcChart.destroy();

  pdcChart = new Chart(canvas.getContext("2d"), {
    type: "line",
    data: { labels: labelsMin, datasets },
    options: {
      ...chartDefaults(),
      scales: {
        x: {
          ...makeTimeAxis(),
          title: { display: true, text: "Duration", color: "#9ca3af" }
        },
        y: makeYAxis("Mean Max Power (W)")
      }
    }
  });

  // PDC has its own zoom (not synced with time charts)
  attachPDCZoom(pdcChart);
}

function attachPDCZoom(chart) {
  const canvas = chart.canvas;
  let isDragging = false, dragStartX = null, overlay = null;

  canvas.addEventListener("mousedown", (ev) => {
    isDragging = true;
    dragStartX = ev.clientX - canvas.getBoundingClientRect().left;
    overlay = document.createElement("div");
    overlay.className = "zoom-overlay";
    overlay.style.left = dragStartX + "px";
    overlay.style.width = "0px";
    canvas.parentElement.style.position = "relative";
    canvas.parentElement.appendChild(overlay);
  });

  canvas.addEventListener("mousemove", (ev) => {
    if (!isDragging || !overlay) return;
    const rect = canvas.getBoundingClientRect();
    const currentX = ev.clientX - rect.left;
    overlay.style.left = Math.min(dragStartX, currentX) + "px";
    overlay.style.width = Math.abs(currentX - dragStartX) + "px";
    overlay.style.top = "0px";
    overlay.style.height = canvas.offsetHeight + "px";
  });

  canvas.addEventListener("mouseup", (ev) => {
    if (!isDragging) return;
    isDragging = false;
    if (overlay) { overlay.remove(); overlay = null; }
    const rect = canvas.getBoundingClientRect();
    const dragEndX = ev.clientX - rect.left;
    if (Math.abs(dragEndX - dragStartX) < 5) return;
    const xScale = chart.scales.x;
    chart.options.scales.x.min = xScale.getValueForPixel(Math.min(dragStartX, dragEndX));
    chart.options.scales.x.max = xScale.getValueForPixel(Math.max(dragStartX, dragEndX));
    chart.update("none");
  });

  canvas.addEventListener("mouseleave", () => { if (overlay) { overlay.remove(); overlay = null; } isDragging = false; });
  canvas.addEventListener("dblclick", () => { chart.options.scales.x.min = undefined; chart.options.scales.x.max = undefined; chart.update("none"); });
}

// ═══════════════════════════════════════════════════════════════
// 12. GPS MAP
// ═══════════════════════════════════════════════════════════════

function renderMap() {
  const container = document.getElementById("routeMap");
  if (!container) return;

  const tracks = [];
  for (const key of ["A", "B", "C"]) {
    const p = parsedFiles[key];
    if (!p) continue;
    const coords = [];
    for (let i = 0; i < p.latitude.length; i++) {
      const lat = p.latitude[i], lng = p.longitude[i];
      if (lat != null && lng != null && lat !== 0 && lng !== 0) {
        coords.push([lat, lng]);
      }
    }
    if (coords.length > 10) {
      tracks.push({ key, coords, color: DEVICE_COLORS[key].border, label: deviceLabels[key] });
    }
  }

  if (tracks.length === 0) {
    container.closest(".card").style.display = "none";
    return;
  }
  container.closest(".card").style.display = "";

  if (leafletMap) { leafletMap.remove(); leafletMap = null; }

  leafletMap = L.map(container, { zoomControl: true, attributionControl: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; OpenStreetMap contributors', maxZoom: 19
  }).addTo(leafletMap);

  const allCoords = [];
  mapLayers = [];

  for (const track of tracks) {
    const polyline = L.polyline(track.coords, { color: track.color, weight: 3, opacity: 0.85 }).addTo(leafletMap);
    polyline.bindTooltip(track.label);
    mapLayers.push(polyline);
    allCoords.push(...track.coords);
  }

  if (allCoords.length > 0) {
    leafletMap.fitBounds(L.latLngBounds(allCoords), { padding: [20, 20] });
  }
}

// ═══════════════════════════════════════════════════════════════
// 13. DEVICE SOURCES CARD
// ═══════════════════════════════════════════════════════════════

function updateDeviceSources() {
  const container = document.getElementById("deviceSources");
  if (!container) return;

  const allMetrics = ["power", "heartRate", "cadence", "speed", "altitude", "latitude"];
  const metricLabels = {
    power: "Power", heartRate: "Heart Rate", cadence: "Cadence",
    speed: "Speed", altitude: "Elevation", latitude: "GPS"
  };

  let html = "";

  for (const key of ["A", "B", "C"]) {
    const p = parsedFiles[key];
    html += `<div class="device-col"><h3>${deviceLabels[key]}</h3>`;

    if (!p) {
      html += `<p class="device-empty">No file loaded</p></div>`;
      continue;
    }

    html += `<div class="device-info">`;
    if (p.sport) html += `<span class="device-tag">${p.sport}${p.subSport ? ` / ${p.subSport}` : ""}</span>`;
    html += `<span class="device-tag">${p.totalRecords} records</span>`;
    html += `<span class="device-tag">${p.isSmartRecording ? "smart" : "1s"} recording</span>`;
    if (p.pauses.length > 0) html += `<span class="device-tag">${p.pauses.length} pauses</span>`;
    if (p.timestamps.length > 1) {
      const dur = p.timestamps[p.timestamps.length - 1] - p.timestamps[0];
      html += `<span class="device-tag">${formatElapsed(dur)}</span>`;
    }
    html += `</div>`;

    html += `<ul class="device-metric-list">`;
    for (const mk of allMetrics) {
      const arr = p[mk];
      const has = Array.isArray(arr) && arr.some(v => v != null && v !== 0);
      html += `<li>${metricLabels[mk]}: ${has
        ? '<span class="metric-ok">present</span>'
        : '<span class="metric-missing">--</span>'
      }</li>`;
    }
    html += `</ul></div>`;
  }

  container.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// 14. SUMMARY TABLE + DIAGNOSIS
// ═══════════════════════════════════════════════════════════════

function renderSummary(data) {
  const tableDiv = document.getElementById("summaryTable");
  const diagDiv = document.getElementById("diagnosisPanel");
  if (!tableDiv) return;

  const fmt = (x, d = 1) => (x == null || Number.isNaN(x)) ? "—" : x.toFixed(d);
  const fmtPct = (x, d = 1) => (x == null || Number.isNaN(x)) ? "—" : x.toFixed(d) + "%";

  // Per-device stats — use raw data for stats (not display-transformed)
  let html = `<table class="summary-table">
    <thead><tr><th>Metric</th><th>Device</th><th>Samples</th><th>Mean</th><th>Min</th><th>Max</th><th>Std Dev</th><th>Dropouts</th></tr></thead><tbody>`;

  const metricDefs = [
    { key: "power", label: "Power", unit: "W" },
    { key: "heartRate", label: "Heart Rate", unit: "bpm" },
    { key: "cadence", label: "Cadence", unit: "rpm" },
    { key: "speed", label: "Speed", unit: "m/s" },
    { key: "altitude", label: "Elevation", unit: "m" }
  ];

  for (const { key, label, unit } of metricDefs) {
    for (const dev of ["A", "B", "C"]) {
      const series = data[dev][key];
      if (!Array.isArray(series)) continue;
      const s = basicStats(series, key);
      if (!s || s.count === 0) continue;
      html += `<tr>
        <td>${label}</td>
        <td><span class="device-badge device-badge-${dev}">${deviceLabels[dev]}</span></td>
        <td>${s.count}</td>
        <td>${fmt(s.mean)}</td>
        <td>${fmt(s.min)}</td>
        <td>${fmt(s.max)}</td>
        <td>${fmt(s.std, 2)}</td>
        <td>${s.dropoutCount} (${fmtPct(s.dropoutPct)})</td>
      </tr>`;
    }
  }

  html += `</tbody></table>`;

  // Comparison table
  html += `<h3 class="subsection-title">Pairwise Comparison vs ${deviceLabels.A} (reference)</h3>`;
  html += `<table class="summary-table">
    <thead><tr><th>Metric</th><th>Comparison</th><th>Mean Diff</th><th>Mean Diff %</th><th>MAE</th><th>RMSE</th><th>Correlation</th><th>Drift/min</th><th>Samples</th></tr></thead><tbody>`;

  const diagnosisItems = [];

  for (const { key, label, unit } of metricDefs) {
    for (const otherKey of ["B", "C"]) {
      const serA = data.A[key];
      const serOther = data[otherKey][key];
      if (!Array.isArray(serA) || !Array.isArray(serOther)) continue;

      const comp = pairwiseComparison(serA, serOther, key);
      if (!comp) continue;

      html += `<tr>
        <td>${label}</td>
        <td><span class="device-badge device-badge-${otherKey}">${deviceLabels[otherKey]}</span> vs <span class="device-badge device-badge-A">${deviceLabels.A}</span></td>
        <td>${fmt(comp.meanDiff, 2)} ${unit}</td>
        <td>${fmtPct(comp.meanRelPct, 2)}</td>
        <td>${fmt(comp.mae, 2)}</td>
        <td>${fmt(comp.rmse, 2)}</td>
        <td>${fmt(comp.correlation, 4)}</td>
        <td>${fmt(comp.driftPerMinute, 3)}</td>
        <td>${comp.sampleCount}</td>
      </tr>`;

      diagnosisItems.push({ label, device: deviceLabels[otherKey], pattern: comp.pattern });
    }
  }

  html += `</tbody></table>`;
  tableDiv.innerHTML = html;

  // Diagnosis panel
  if (diagDiv && diagnosisItems.length) {
    let diagHtml = "";
    for (const item of diagnosisItems) {
      for (const p of item.pattern) {
        const severityClass = p.severity === "high" ? "diag-high" : p.severity === "moderate" ? "diag-moderate" : p.type === "ok" ? "diag-ok" : "diag-low";
        const icon = p.type === "ok" ? "&#10003;" : p.type === "offset" ? "&#8597;" : p.type === "drift" ? "&#8599;" : p.type === "dropout" ? "&#9888;" : p.type === "smoothing" ? "&#8764;" : p.type === "correlation" ? "&#119903;" : "&#8226;";
        diagHtml += `<div class="diag-item ${severityClass}">
          <span class="diag-icon">${icon}</span>
          <strong>${item.label}</strong> — ${item.device}: ${p.desc}
        </div>`;
      }
    }
    diagDiv.innerHTML = diagHtml;
  }
}

// ═══════════════════════════════════════════════════════════════
// 15. CSV EXPORT
// ═══════════════════════════════════════════════════════════════

function exportAlignedCSV() {
  if (!aligned) return;

  const fields = ["power", "heartRate", "cadence", "speed", "altitude"];
  const headers = ["elapsed_sec"];

  for (const dev of ["A", "B", "C"]) {
    for (const f of fields) {
      if (Array.isArray(aligned[dev][f])) {
        headers.push(`${deviceLabels[dev]}_${f}`);
      }
    }
  }

  const t0 = aligned.times[0];
  const rows = [headers.join(",")];

  for (let i = 0; i < aligned.times.length; i++) {
    const row = [Math.round(aligned.times[i] - t0)];
    for (const dev of ["A", "B", "C"]) {
      for (const f of fields) {
        if (Array.isArray(aligned[dev][f])) {
          const v = aligned[dev][f][i];
          row.push(v != null ? v.toFixed(2) : "");
        }
      }
    }
    rows.push(row.join(","));
  }

  const blob = new Blob([rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sensor-comparison.csv";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ═══════════════════════════════════════════════════════════════
// 16. ALIGNMENT CONTROLS
// ═══════════════════════════════════════════════════════════════

function updateOffsetDisplay() {
  const bVal = document.getElementById("offsetBValue");
  const cVal = document.getElementById("offsetCValue");
  if (bVal) bVal.textContent = `${manualOffsets.B >= 0 ? "+" : ""}${manualOffsets.B}s`;
  if (cVal) cVal.textContent = `${manualOffsets.C >= 0 ? "+" : ""}${manualOffsets.C}s`;
}

function autoAlignFiles() {
  const refData = parsedFiles.A;
  if (!refData) return;

  let refSeries = null, refKey = null;
  for (const key of ["power", "heartRate", "cadence"]) {
    if (Array.isArray(refData[key]) && refData[key].some(v => v != null && v > 0)) {
      refSeries = refData[key];
      refKey = key;
      break;
    }
  }
  if (!refSeries) return;

  if (parsedFiles.B) {
    const otherSeries = parsedFiles.B[refKey];
    if (Array.isArray(otherSeries) && otherSeries.some(v => v != null && v > 0)) {
      manualOffsets.B = Math.round(estimateOffsetByCrossCorrelation(
        refData.timestamps, refSeries,
        parsedFiles.B.timestamps, otherSeries, 120
      ));
    }
  }

  if (parsedFiles.C) {
    const otherSeries = parsedFiles.C[refKey];
    if (Array.isArray(otherSeries) && otherSeries.some(v => v != null && v > 0)) {
      manualOffsets.C = Math.round(estimateOffsetByCrossCorrelation(
        refData.timestamps, refSeries,
        parsedFiles.C.timestamps, otherSeries, 120
      ));
    }
  }

  const sliderB = document.getElementById("offsetB");
  const sliderC = document.getElementById("offsetC");
  if (sliderB) sliderB.value = manualOffsets.B;
  if (sliderC) sliderC.value = manualOffsets.C;
  updateOffsetDisplay();
}

// ═══════════════════════════════════════════════════════════════
// 17. MAIN ANALYSIS PIPELINE
// ═══════════════════════════════════════════════════════════════

function runAnalysis() {
  const errorDiv = document.getElementById("error");
  if (errorDiv) errorDiv.textContent = "";

  try {
    globalZoom = { min: undefined, max: undefined };
    aligned = alignTimeSeries(parsedFiles.A, parsedFiles.B, parsedFiles.C, 1, manualOffsets.B, manualOffsets.C);

    document.getElementById("resultsSection").style.display = "";

    updateDeviceSources();

    for (const m of METRICS) {
      renderMetricChart(aligned, m);
      renderDiffChart(aligned, m);
    }

    renderElevationChart(aligned);
    renderPDC(aligned);
    renderMap();
    renderSummary(aligned);

    const alignInfo = document.getElementById("alignInfo");
    if (alignInfo) {
      const overlapSec = aligned.times.length;
      const pauseCount = aligned.pauses ? aligned.pauses.length : 0;
      let info = `Overlap: ${formatElapsed(overlapSec)} | ${aligned.times.length} data points`;
      if (pauseCount > 0) info += ` | ${pauseCount} pauses detected`;
      alignInfo.textContent = info;
    }

  } catch (err) {
    console.error(err);
    if (errorDiv) errorDiv.textContent = err.message || "Error analyzing files.";
  }
}

// Re-render charts only (for smoothing/pace changes)
function reRenderCharts() {
  if (!aligned) return;
  for (const m of METRICS) {
    renderMetricChart(aligned, m);
    renderDiffChart(aligned, m);
  }
  renderElevationChart(aligned);
}

// ═══════════════════════════════════════════════════════════════
// 18. RESET
// ═══════════════════════════════════════════════════════════════

function resetTool() {
  ["fileA", "fileB", "fileC"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });
  ["labelA", "labelB", "labelC"].forEach(id => { const el = document.getElementById(id); if (el) el.value = ""; });

  const errorDiv = document.getElementById("error");
  if (errorDiv) errorDiv.textContent = "";

  // Clear file size displays
  document.querySelectorAll(".file-size").forEach(el => { el.textContent = ""; });

  parsedFiles = { A: null, B: null, C: null };
  aligned = null;
  deviceLabels = { A: "Device A", B: "Device B", C: "Device C" };
  manualOffsets = { B: 0, C: 0 };
  globalZoom = { min: undefined, max: undefined };

  Object.keys(metricCharts).forEach(k => { if (metricCharts[k]) { metricCharts[k].destroy(); metricCharts[k] = null; } });
  Object.keys(diffCharts).forEach(k => { if (diffCharts[k]) { diffCharts[k].destroy(); diffCharts[k] = null; } });
  if (pdcChart) { pdcChart.destroy(); pdcChart = null; }
  if (elevChart) { elevChart.destroy(); elevChart = null; }
  if (leafletMap) { leafletMap.remove(); leafletMap = null; }

  const tableDiv = document.getElementById("summaryTable");
  const diagDiv = document.getElementById("diagnosisPanel");
  const sourcesDiv = document.getElementById("deviceSources");
  const alignInfo = document.getElementById("alignInfo");
  if (tableDiv) tableDiv.innerHTML = "";
  if (diagDiv) diagDiv.innerHTML = "";
  if (sourcesDiv) sourcesDiv.innerHTML = "";
  if (alignInfo) alignInfo.textContent = "";

  document.getElementById("resultsSection").style.display = "none";

  const sliderB = document.getElementById("offsetB");
  const sliderC = document.getElementById("offsetC");
  if (sliderB) sliderB.value = 0;
  if (sliderC) sliderC.value = 0;
  updateOffsetDisplay();
}

// ═══════════════════════════════════════════════════════════════
// 19. WIRE UP UI
// ═══════════════════════════════════════════════════════════════

document.addEventListener("DOMContentLoaded", () => {
  const analyzeBtn = document.getElementById("analyzeBtn");
  const resetBtn = document.getElementById("resetBtn");
  const autoAlignBtn = document.getElementById("autoAlignBtn");
  const reAlignBtn = document.getElementById("reAlignBtn");
  const exportBtn = document.getElementById("exportCsvBtn");
  const smoothingSelect = document.getElementById("smoothingSelect");
  const paceToggle = document.getElementById("paceToggle");
  const errorDiv = document.getElementById("error");

  document.getElementById("resultsSection").style.display = "none";

  // File size display on selection
  ["fileA", "fileB", "fileC"].forEach(id => {
    const input = document.getElementById(id);
    if (!input) return;
    input.addEventListener("change", () => {
      const sizeSpan = input.parentElement.querySelector(".file-size");
      if (sizeSpan && input.files[0]) {
        const sizeMB = (input.files[0].size / (1024 * 1024)).toFixed(1);
        sizeSpan.textContent = `${sizeMB} MB`;
      } else if (sizeSpan) {
        sizeSpan.textContent = "";
      }
    });
  });

  if (resetBtn) resetBtn.addEventListener("click", resetTool);

  // Smoothing
  if (smoothingSelect) {
    smoothingSelect.addEventListener("change", () => {
      smoothingWindow = parseInt(smoothingSelect.value, 10);
      reRenderCharts();
    });
  }

  // Pace toggle
  if (paceToggle) {
    paceToggle.addEventListener("click", () => {
      speedMode = speedMode === "speed" ? "pace" : "speed";
      paceToggle.textContent = speedMode === "pace" ? "Show km/h" : "Show pace";
      reRenderCharts();
    });
  }

  // Export
  if (exportBtn) exportBtn.addEventListener("click", exportAlignedCSV);

  // Offset sliders
  const sliderB = document.getElementById("offsetB");
  const sliderC = document.getElementById("offsetC");
  if (sliderB) sliderB.addEventListener("input", () => { manualOffsets.B = parseInt(sliderB.value, 10); updateOffsetDisplay(); });
  if (sliderC) sliderC.addEventListener("input", () => { manualOffsets.C = parseInt(sliderC.value, 10); updateOffsetDisplay(); });

  if (reAlignBtn) reAlignBtn.addEventListener("click", () => { if (parsedFiles.A && parsedFiles.B) runAnalysis(); });
  if (autoAlignBtn) autoAlignBtn.addEventListener("click", () => { if (parsedFiles.A && parsedFiles.B) { autoAlignFiles(); runAnalysis(); } });

  // Reset zoom buttons
  document.querySelectorAll("[data-reset]").forEach(btn => {
    btn.addEventListener("click", () => {
      const key = btn.getAttribute("data-reset");
      if (key === "all") {
        syncZoomToAll(undefined, undefined);
        return;
      }
      if (key === "pdc" && pdcChart) {
        pdcChart.options.scales.x.min = undefined;
        pdcChart.options.scales.x.max = undefined;
        pdcChart.update("none");
      }
    });
  });

  // Analyze
  analyzeBtn.addEventListener("click", async () => {
    if (errorDiv) errorDiv.textContent = "";

    const fileA = document.getElementById("fileA").files[0];
    const fileB = document.getElementById("fileB").files[0];
    const fileC = document.getElementById("fileC").files[0] || null;

    if (!fileA || !fileB) {
      if (errorDiv) errorDiv.textContent = "Upload at least Device A and Device B FIT files.";
      return;
    }

    const lA = document.getElementById("labelA")?.value?.trim();
    const lB = document.getElementById("labelB")?.value?.trim();
    const lC = document.getElementById("labelC")?.value?.trim();
    deviceLabels.A = lA || "Device A";
    deviceLabels.B = lB || "Device B";
    deviceLabels.C = lC || "Device C";

    analyzeBtn.disabled = true;
    analyzeBtn.innerHTML = '<span class="spinner"></span> Parsing...';

    try {
      parsedFiles.A = await parseFitFile(fileA);
      analyzeBtn.innerHTML = '<span class="spinner"></span> Parsing B...';
      parsedFiles.B = await parseFitFile(fileB);
      parsedFiles.C = fileC ? (analyzeBtn.innerHTML = '<span class="spinner"></span> Parsing C...', await parseFitFile(fileC)) : null;

      // Auto-detect sport for pace mode
      const sport = parsedFiles.A.sport || "";
      if (sport.toLowerCase().includes("run")) {
        speedMode = "pace";
        if (paceToggle) paceToggle.textContent = "Show km/h";
      } else {
        speedMode = "speed";
        if (paceToggle) paceToggle.textContent = "Show pace";
      }

      analyzeBtn.innerHTML = '<span class="spinner"></span> Aligning...';
      autoAlignFiles();

      analyzeBtn.innerHTML = '<span class="spinner"></span> Rendering...';
      // Yield to UI thread before heavy rendering
      await new Promise(r => setTimeout(r, 0));
      runAnalysis();
    } catch (err) {
      console.error(err);
      if (errorDiv) errorDiv.textContent = err.message || "Error parsing FIT files.";
    } finally {
      analyzeBtn.disabled = false;
      analyzeBtn.textContent = "Analyze Files";
    }
  });

  updateOffsetDisplay();
});
