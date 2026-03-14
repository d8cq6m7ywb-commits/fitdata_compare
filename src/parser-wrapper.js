import FitParser from "fit-file-parser";
import { Buffer } from "buffer";

// Garmin epoch: seconds between Unix epoch (1970-01-01) and Garmin epoch (1989-12-31)
const GARMIN_EPOCH_OFFSET = 631065600;

function normalizeTimestamp(raw) {
  if (raw == null) return null;
  if (raw instanceof Date) return raw.getTime() / 1000;

  const n = Number(raw);
  if (!Number.isFinite(n)) return null;

  // Heuristic: distinguish Garmin epoch seconds, Unix seconds, Unix milliseconds
  if (n > 1e12) {
    // Unix milliseconds (e.g. 1701648000000)
    return n / 1000;
  } else if (n > 1e9) {
    // Unix seconds (e.g. 1701648000)
    return n;
  } else {
    // Garmin epoch seconds (e.g. 1070582400) — small number relative to Unix
    return n + GARMIN_EPOCH_OFFSET;
  }
}

export async function parseFitToTimeSeries(arrayBuffer) {
  return new Promise((resolve, reject) => {
    const fitParser = new FitParser({
      force: true,
      speedUnit: "m/s",
      lengthUnit: "m",
      temperatureUnit: "celsius",
      pressureUnit: "bar",
      elapsedRecordField: true,
      mode: "list"
    });

    const buf = Buffer.from(arrayBuffer);

    fitParser.parse(buf, (error, data) => {
      if (error) {
        reject(error);
        return;
      }

      const records = data.records || [];

      const timestamps = [];
      const power = [];
      const heartRate = [];
      const speed = [];
      const cadence = [];
      const latitude = [];
      const longitude = [];
      const altitude = [];
      const temperature = [];
      const distance = [];

      for (const rec of records) {
        timestamps.push(normalizeTimestamp(rec.timestamp));
        power.push(rec.power ?? null);
        heartRate.push(rec.heart_rate ?? null);
        speed.push(rec.speed ?? null);
        cadence.push(rec.cadence ?? null);
        latitude.push(rec.position_lat ?? null);
        longitude.push(rec.position_long ?? null);
        altitude.push(rec.altitude ?? rec.enhanced_altitude ?? null);
        temperature.push(rec.temperature ?? null);
        distance.push(rec.distance ?? null);
      }

      // Compute recording interval stats
      const validTs = timestamps.filter(t => t != null);
      const intervals = [];
      for (let i = 1; i < validTs.length; i++) {
        intervals.push(validTs[i] - validTs[i - 1]);
      }
      intervals.sort((a, b) => a - b);
      const medianInterval = intervals.length > 0 ? intervals[Math.floor(intervals.length / 2)] : 1;

      // Detect pauses (gaps > 5 seconds)
      const pauses = [];
      for (let i = 1; i < validTs.length; i++) {
        const gap = validTs[i] - validTs[i - 1];
        if (gap > 5) {
          pauses.push({ startTime: validTs[i - 1], endTime: validTs[i], gapSec: gap });
        }
      }

      // Recording mode
      const isSmartRecording = medianInterval > 1.5;

      // Extract session/activity info
      const sessions = data.sessions || [];
      let sport = null;
      let subSport = null;
      if (sessions.length > 0) {
        sport = sessions[0].sport || null;
        subSport = sessions[0].sub_sport || null;
      }

      resolve({
        timestamps,
        power,
        heartRate,
        speed,
        cadence,
        latitude,
        longitude,
        altitude,
        temperature,
        distance,
        sport,
        subSport,
        totalRecords: records.length,
        medianInterval,
        isSmartRecording,
        pauses
      });
    });
  });
}
