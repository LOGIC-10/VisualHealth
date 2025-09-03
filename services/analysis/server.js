import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const PORT = process.env.PORT || 4004;

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '25mb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// Accept JSON: { sampleRate: number, channel: number, pcm: number[] }
app.post('/analyze', (req, res) => {
  try {
    const { sampleRate, pcm } = req.body || {};
    if (!sampleRate || !Array.isArray(pcm) || pcm.length === 0) {
      return res.status(400).json({ error: 'sampleRate and pcm required' });
    }
    // Normalize to Float32 array
    const x = Float32Array.from(pcm);

    // Basic features
    const n = x.length;
    const mean = x.reduce((a, b) => a + b, 0) / n;
    const variance = x.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
    const rms = Math.sqrt(variance);
    // Zero-crossing rate
    let zc = 0;
    for (let i = 1; i < n; i++) {
      if ((x[i - 1] >= 0 && x[i] < 0) || (x[i - 1] < 0 && x[i] >= 0)) zc++;
    }
    const zcr = zc / n * sampleRate; // crossings per second

    // Simple envelope and peak rate (very rough proxy)
    const window = Math.max(1, Math.floor(sampleRate * 0.02)); // 20ms
    const env = new Float32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(x[i]);
      acc += v - (i >= window ? Math.abs(x[i - window]) : 0);
      env[i] = acc / Math.min(i + 1, window);
    }
    // Peak detection
    const peaks = [];
    for (let i = 1; i < n - 1; i++) {
      if (env[i] > env[i - 1] && env[i] > env[i + 1] && env[i] > 0.02) {
        peaks.push(i);
      }
    }
    const seconds = n / sampleRate;
    const peakRate = peaks.length / seconds; // events per second

    res.json({
      sampleRate,
      durationSec: seconds,
      rms,
      zcrPerSec: zcr,
      envelopePeaks: peaks.slice(0, 1000),
      peakRatePerSec: peakRate
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'analysis failed' });
  }
});

app.listen(PORT, () => console.log(`analysis-service on :${PORT}`));

