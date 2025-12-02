async function parseFitFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const arrayBuffer = e.target.result;
        // This depends on how fit-entry.js exposes its API.
        // You adapt this call.
        const result = parseFitToTimeSeries(arrayBuffer); 
        // Expected shape:
        // {
        //   timestamps: [t1, t2, ...],  // epoch seconds or ms
        //   power: [...],
        //   heartRate: [...],
        //   speed: [...],
        //   cadence: [...]
        // }
        resolve(result);
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}
