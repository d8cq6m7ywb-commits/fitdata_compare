// ---------- 1. Parse a FIT file into time series ----------

async function parseFitFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = function (e) {
      const arrayBuffer = e.target.result;

      try {
        // FitParser is expected to be a global created by fit-entry.js bundle
        if (typeof FitParser !== "function") {
          reject(new Error("FitParser is not available. Check fit-entry.js."));
          return;
        }

        const parser = new FitParser({
          force: true,
          speedUnit: "m/s",
          lengthUnit: "m",
          temperatureUnit: "celsius",
          mode: "list", // gives you top-level records[]
        });

        parser.parse(arrayBuffer, (error, data) => {
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

          for (const r of records) {
            if (r.timestamp == null) continue;

            // Original parser uses ms since epoch in that code;
            // convert to seconds for sanity
            const tSec = r.timestamp / 1000;

            timestamps.push(tSec);
            power.push(r.power ?? null);
            heartRate.push(r.heart_rate ?? null);
            speed.push(r.speed ?? null);
            cadence.push(r.cadence ?? null);
          }

          resolve({ timestamps, power, heartRate, speed, cadence });
        });
      } catch (err) {
        reject(err);
      }
    };

    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ---------- 2. Wire up the Analyze button (for now: log result) ----------

document.addEventListener("DOMContentLoaded", () => {
  const analyzeBtn = document.getElementById("analyzeBtn");
  const errorDiv = document.getElementById("error");

  analyzeBtn.addEventListener("click", async () => {
    errorDiv.textContent = "";

    const fileA = document.getElementById("fileA").files[0];
    const fileB = document.getElementById("fileB").files[0];

    if (!fileA || !fileB) {
      errorDiv.textContent = "Please select both FIT files.";
      return;
    }

    try {
      console.log("Parsing Device A…");
      const parsedA = await parseFitFile(fileA);
      console.log("Device A parsed:", parsedA);

      console.log("Parsing Device B…");
      const parsedB = await parseFitFile(fileB);
      console.log("Device B parsed:", parsedB);

      // Temporary: just show something in the page
      document.getElementById("summaryTable").textContent =
        "Parsed A: " +
        parsedA.timestamps.length +
        " samples, Parsed B: " +
        parsedB.timestamps.length +
        " samples.";

      // Next step later: alignTimeSeries(parsedA, parsedB, 1) and plot.
    } catch (err) {
      console.error(err);
      errorDiv.textContent = err.message || "Error parsing FIT files.";
    }
  });
});
