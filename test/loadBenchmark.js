import WebSocket from 'ws';

// Generates an initial realistic Excalidraw scene with base elements
function generateBaseElements(count = 25) {
  const elements = [];
  for (let i = 0; i < count; i++) {
    elements.push({
      id: `base-elem-${i}`,
      type: i % 2 === 0 ? 'rectangle' : 'freedraw',
      x: 100 + (i % 5) * 120,
      y: 100 + Math.floor(i / 5) * 80,
      width: 100,
      height: 60,
      strokeColor: '#1e1e1e',
      backgroundColor: '#ffffff',
      version: 1,
      versionNonce: 1000 + i,
      isDeleted: false,
      points: i % 2 === 1 ? Array.from({ length: 40 }, (_, idx) => [idx * 2, Math.sin(idx) * 10]) : undefined,
    });
  }
  return elements;
}

// Runs a single load benchmark run for N viewers
async function runTier(viewerCount, durationMs = 3000, hasSlowClient = false) {
  const wsUrl = 'ws://localhost:3001/ws';
  const roomId = `bench-${viewerCount}-${Date.now()}`;

  // 1. Connect broadcaster
  const broadcaster = new WebSocket(wsUrl);
  await new Promise((r) => broadcaster.on('open', r));
  broadcaster.send(JSON.stringify({ type: 'join', role: 'broadcaster', roomId }));

  await new Promise((r) => setTimeout(r, 100));

  // 2. Connect N viewers
  const viewers = [];
  const latencies = [];
  let totalBytesReceived = 0;
  let totalMessagesReceived = 0;

  for (let i = 0; i < viewerCount; i++) {
    const isSlow = hasSlowClient && i === 0;
    const ws = new WebSocket(wsUrl);
    viewers.push({ ws, isSlow, slowTimer: null });
  }

  await Promise.all(viewers.map((v) => new Promise((r) => v.ws.on('open', r))));

  viewers.forEach((v) => {
    v.ws.send(JSON.stringify({ type: 'join', role: 'viewer', roomId }));

    if (v.isSlow) {
      // Simulate slow client via TCP backpressure: pauses socket and reads intermittently
      v.ws.pause();
      v.slowTimer = setInterval(() => {
        v.ws.resume();
        setTimeout(() => {
          if (v.ws.readyState === WebSocket.OPEN) {
            v.ws.pause();
          }
        }, 15);
      }, 150);
    }

    v.ws.on('message', (data) => {
      const receiveTime = Date.now();
      totalBytesReceived += data.length;
      totalMessagesReceived += 1;

      try {
        const msg = JSON.parse(data.toString());
        if (msg.timestamp) {
          const lat = Math.max(0, receiveTime - msg.timestamp);
          latencies.push(lat);
        }
      } catch (e) {}
    });
  });

  await new Promise((r) => setTimeout(r, 200));

  // 3. Continuously stream drawing updates from broadcaster
  const baseElements = generateBaseElements(25);
  let activeStrokePoints = [[0, 0]];
  let strokeId = `stroke-${Date.now()}`;
  let sequence = 0;
  let updatesSent = 0;
  let bytesSent = 0;

  const startCpu = process.cpuUsage();
  const startTime = Date.now();

  const drawInterval = 16; // 16ms cadence
  const totalSteps = Math.floor(durationMs / drawInterval);

  for (let step = 0; step < totalSteps; step++) {
    sequence++;
    updatesSent++;

    activeStrokePoints.push([step * 3, Math.sin(step * 0.2) * 20]);
    const currentStroke = {
      id: strokeId,
      type: 'freedraw',
      x: 200,
      y: 200,
      width: step * 3,
      height: 40,
      points: [...activeStrokePoints],
      version: sequence,
      versionNonce: 5000 + sequence,
      isDeleted: false,
    };

    const isStrokeEnd = step % 40 === 39;
    const allElements = [...baseElements, currentStroke];

    const payload = {
      type: isStrokeEnd ? 'stroke_complete' : 'batch_update',
      roomId,
      elements: allElements,
      sequence,
      timestamp: Date.now(),
      isFinal: isStrokeEnd,
      appState: { zoom: { value: 1.0 }, scrollX: 0, scrollY: 0 },
    };

    const raw = JSON.stringify(payload);
    bytesSent += raw.length;
    broadcaster.send(raw);

    if (isStrokeEnd) {
      baseElements.push(currentStroke);
      activeStrokePoints = [[0, 0]];
      strokeId = `stroke-${Date.now()}-${step}`;
    }

    await new Promise((r) => setTimeout(r, drawInterval));
  }

  // Grace period to receive all in-flight messages
  await new Promise((r) => setTimeout(r, 400));

  const totalDurationSec = (Date.now() - startTime) / 1000;
  const cpuDiff = process.cpuUsage(startCpu);
  const cpuPercent = ((cpuDiff.user + cpuDiff.system) / (totalDurationSec * 1000000) * 100).toFixed(1);

  // Close all sockets and clear timers
  broadcaster.close();
  viewers.forEach((v) => {
    if (v.slowTimer) clearInterval(v.slowTimer);
    v.ws.close();
  });

  latencies.sort((a, b) => a - b);
  const avgLat = latencies.length ? (latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(1) : 0;
  const p95Lat = latencies.length ? latencies[Math.floor(latencies.length * 0.95)] : 0;
  const maxLat = latencies.length ? latencies[latencies.length - 1] : 0;
  const minLat = latencies.length ? latencies[0] : 0;

  const totalMbReceived = (totalBytesReceived / (1024 * 1024)).toFixed(2);
  const mbPerSec = (totalBytesReceived / (1024 * 1024 * totalDurationSec)).toFixed(2);
  const avgPayloadKb = totalMessagesReceived ? (totalBytesReceived / totalMessagesReceived / 1024).toFixed(1) : 0;

  return {
    viewerCount,
    durationSec: totalDurationSec.toFixed(1),
    updatesSent,
    messagesReceived: totalMessagesReceived,
    totalMbReceived,
    mbPerSec,
    avgPayloadKb,
    minLat,
    avgLat,
    p95Lat,
    maxLat,
    cpuPercent,
  };
}

async function main() {
  console.log('========================================================================');
  console.log('   EXCALISTREAM ONE-TO-MANY LOAD BENCHMARK (BASELINE MEASUREMENTS)');
  console.log('========================================================================\n');

  const tiers = [1, 5, 10, 25, 50];
  const results = [];

  for (const count of tiers) {
    process.stdout.write(`Benchmarking ${count} viewer(s)... `);
    const res = await runTier(count, 3000, false);
    results.push(res);
    console.log(`Done. (Avg Lat: ${res.avgLat}ms, Bandwidth: ${res.mbPerSec} MB/s, Egress: ${res.totalMbReceived} MB)`);
    await new Promise((r) => setTimeout(r, 400));
  }

  // Also test with 1 slow client among 25 viewers to measure backpressure impact
  process.stdout.write(`Benchmarking 25 viewers with 1 slow client (Backpressure baseline)... `);
  const slowRes = await runTier(25, 3000, true);
  console.log(`Done. (Avg Lat: ${slowRes.avgLat}ms, p95: ${slowRes.p95Lat}ms, Max Lat: ${slowRes.maxLat}ms)`);

  console.log('\n--- BASELINE BENCHMARK RESULTS TABLE ---');
  console.table(results);

  console.log('\nSlow Client Impact (25 viewers + 1 slow client):');
  console.log(`- Avg Latency: ${slowRes.avgLat}ms | p95: ${slowRes.p95Lat}ms | Max Latency: ${slowRes.maxLat}ms`);
  console.log(`- Total Bandwidth: ${slowRes.mbPerSec} MB/s`);
}

main().catch(console.error);
