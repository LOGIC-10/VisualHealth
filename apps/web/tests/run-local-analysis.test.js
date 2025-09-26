/** @jest-environment jsdom */

describe('run-local-analysis utilities', () => {
  let mod;
  let originalFetch;
  let originalCreateObjectURL;
  let originalRevokeObjectURL;

  const resetEnvAndImport = async () => {
    jest.resetModules();
    process.env.NEXT_PUBLIC_API_ANALYSIS = 'https://analysis.test';
    process.env.NEXT_PUBLIC_API_VIZ = 'https://viz.test';
    mod = await import('../lib/run-local-analysis.js');
  };

  beforeEach(async () => {
    await resetEnvAndImport();
    originalFetch = global.fetch;
    global.fetch = jest.fn();
    originalCreateObjectURL = URL.createObjectURL;
    originalRevokeObjectURL = URL.revokeObjectURL;
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_API_ANALYSIS;
    delete process.env.NEXT_PUBLIC_API_VIZ;
    if (originalFetch === undefined) {
      delete global.fetch;
    } else {
      global.fetch = originalFetch;
    }
    if (originalCreateObjectURL === undefined) {
      delete URL.createObjectURL;
    } else {
      URL.createObjectURL = originalCreateObjectURL;
    }
    if (originalRevokeObjectURL === undefined) {
      delete URL.revokeObjectURL;
    } else {
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  it('converts base64 payloads to float32 arrays and blobs safely', async () => {
    const { base64ToFloat32Array, base64ToBlob, base64ToObjectUrl, revokeObjectUrl } = mod;
    const buffer = new ArrayBuffer(8);
    new Float32Array(buffer).set([0.5, -0.25]);
    const b64 = Buffer.from(buffer).toString('base64');

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const arr = base64ToFloat32Array(b64);
    expect(arr).toBeInstanceOf(Float32Array);
    expect(Array.from(arr)).toEqual([0.5, -0.25]);

    expect(base64ToFloat32Array('invalid!!')).toBeNull();

    URL.createObjectURL = jest.fn(() => 'blob:123');
    URL.revokeObjectURL = jest.fn(() => {});

    const blob = base64ToBlob(b64, 'audio/wav');
    expect(blob.type).toBe('audio/wav');
    const objectUrl = base64ToObjectUrl(b64, 'audio/wav');
    expect(objectUrl).toBe('blob:123');
    revokeObjectUrl(objectUrl);

    expect(URL.createObjectURL).toHaveBeenCalled();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:123');

    warn.mockRestore();
  });

  it('short-circuits when quality check fails', async () => {
    const { runLocalAnalysis } = mod;
    const audioBuffer = {
      sampleRate: 16000,
      duration: 0.5,
      getChannelData: () => new Float32Array([0.1, 0.2, -0.1, 0.05])
    };
    const original = window.AudioContext;
    class MockAudioContext {
      async decodeAudioData() {
        return audioBuffer;
      }
      async close() {}
    }
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: MockAudioContext
    });

    const fileBuffer = Uint8Array.from([0, 1, 2, 3]).buffer;
    const file = {
      type: 'audio/wav',
      async arrayBuffer() {
        return fileBuffer;
      }
    };

    const responses = {
      analyze: { ok: true, json: async () => ({ rms: 0.2 }) },
      quality: { ok: true, json: async () => ({ isHeart: false, qualityOk: false, score: 0.1 }) }
    };

    global.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/analyze')) return responses.analyze;
      if (url.endsWith('/pcg_quality_pcm')) return responses.quality;
      throw new Error(`Unexpected fetch ${url}`);
    });

    const result = await runLocalAnalysis(file);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: original });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('quality');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns combined analysis artifacts when services succeed', async () => {
    const { runLocalAnalysis } = mod;
    const channel = new Float32Array(1600).fill(0.05);
    const audioBuffer = {
      sampleRate: 16000,
      duration: channel.length / 16000,
      getChannelData: () => channel
    };
    const original = window.AudioContext;
    class MockAudioContext {
      async decodeAudioData() {
        return audioBuffer;
      }
      async close() {}
    }
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: MockAudioContext
    });

    URL.createObjectURL = jest.fn(() => 'blob:demo');

    const fileBuffer = Uint8Array.from([1, 2, 3, 4]).buffer;
    const file = {
      type: 'audio/wav',
      async arrayBuffer() {
        return fileBuffer;
      }
    };

    const analysisResponse = { rms: 0.2, zcrPerSec: 5 };
    const advPayload = { hrBpm: 72 };
    const specBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const specBlob = {
      type: 'image/png',
      async arrayBuffer() {
        return specBytes.buffer;
      }
    };
    const extraPayload = { crestFactor: 1.2 };

    global.fetch.mockImplementation(async (url) => {
      if (url.endsWith('/analyze')) return { ok: true, json: async () => analysisResponse };
      if (url.endsWith('/pcg_quality_pcm')) return { ok: true, json: async () => ({ isHeart: true, qualityOk: true }) };
      if (url.endsWith('/pcg_advanced')) return { ok: true, json: async () => advPayload };
      if (url.endsWith('/spectrogram_pcm')) return { ok: true, blob: async () => specBlob };
      if (url.endsWith('/features_pcm')) return { ok: true, json: async () => extraPayload };
      throw new Error(`Unexpected fetch ${url}`);
    });

    const result = await runLocalAnalysis(file);
    Object.defineProperty(window, 'AudioContext', { configurable: true, value: original });

    expect(result.ok).toBe(true);
    expect(result.features).toEqual(analysisResponse);
    expect(result.adv).toEqual(advPayload);
    expect(result.extra).toEqual(extraPayload);
    expect(result.specBase64).toMatch(/^iVBOR/);
    expect(result.audioBase64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(result.payloadSampleRate).toBeGreaterThan(0);
  });
});
