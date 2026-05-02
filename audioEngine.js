const VOICE_RATIOS = [1, 1.125, 1.25, 1.5, 1.75, 2.25];
const MAX_VOICES = VOICE_RATIOS.length;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const norm = (value, min, max) => clamp((value - min) / (max - min));

function setParam(param, value, time, glide = 0.045) {
    param.cancelScheduledValues(time);
    param.setTargetAtTime(value, time, glide);
}

function makeSaturator(amount) {
    const samples = 512;
    const curve = new Float32Array(samples);
    const drive = Math.max(1, amount);

    for (let i = 0; i < samples; i++) {
        const x = (i / (samples - 1)) * 2 - 1;
        curve[i] = Math.tanh(x * drive);
    }

    return curve;
}

class CellFlowAudioEngine {
    constructor() {
        this.context = null;
        this.master = null;
        this.compressor = null;
        this.delay = null;
        this.delayFeedback = null;
        this.delayWet = null;
        this.delayFilter = null;
        this.noiseFilter = null;
        this.noiseGain = null;
        this.noiseSource = null;
        this.shaper = null;
        this.mediaDestination = null;
        this.voices = [];
        this.started = false;
        this.grainTimer = null;
        this.latestParams = null;
        this.lastGrainTime = 0;
        this.saturatorAmount = null;
    }

    async start(params) {
        if (this.started) return;

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            throw new Error('Web Audio is not supported in this browser.');
        }

        this.context = this.context || new AudioContextClass();
        await this.context.resume();
        this.buildGraph();
        this.started = true;
        this.update(params || this.latestParams || {});
        this.startGrainScheduler();
    }

    stop() {
        if (!this.started || !this.context) return;

        const now = this.context.currentTime;
        setParam(this.master.gain, 0.0001, now, 0.08);
        clearInterval(this.grainTimer);
        this.grainTimer = null;

        window.setTimeout(() => {
            this.voices.forEach((voice) => {
                voice.carrier.stop();
                voice.modulator.stop();
            });
            this.noiseSource.stop();
            this.voices = [];
            this.started = false;
            this.disconnectGraph();
        }, 180);
    }

    buildGraph() {
        if (this.master) return;

        const ctx = this.context;
        this.master = ctx.createGain();
        this.master.gain.value = 0.0001;

        this.compressor = ctx.createDynamicsCompressor();
        this.compressor.threshold.value = -20;
        this.compressor.knee.value = 18;
        this.compressor.ratio.value = 4;
        this.compressor.attack.value = 0.015;
        this.compressor.release.value = 0.18;

        this.delay = ctx.createDelay(1.8);
        this.delay.delayTime.value = 0.18;
        this.delayFeedback = ctx.createGain();
        this.delayFeedback.gain.value = 0.22;
        this.delayWet = ctx.createGain();
        this.delayWet.gain.value = 0.12;
        this.delayFilter = ctx.createBiquadFilter();
        this.delayFilter.type = 'lowpass';
        this.delayFilter.frequency.value = 2200;

        this.shaper = ctx.createWaveShaper();
        this.shaper.curve = makeSaturator(1.6);
        this.shaper.oversample = '2x';

        this.master.connect(this.shaper);
        this.shaper.connect(this.compressor);
        this.compressor.connect(ctx.destination);
        this.mediaDestination = ctx.createMediaStreamDestination();
        this.compressor.connect(this.mediaDestination);

        this.delay.connect(this.delayFilter);
        this.delayFilter.connect(this.delayFeedback);
        this.delayFeedback.connect(this.delay);
        this.delayFilter.connect(this.delayWet);
        this.delayWet.connect(this.compressor);

        this.createVoices();
        this.createNoiseBed();
    }

    disconnectGraph() {
        [
            this.master,
            this.compressor,
            this.delay,
            this.delayFeedback,
            this.delayWet,
            this.delayFilter,
            this.noiseFilter,
            this.noiseGain,
            this.noiseSource,
            this.shaper,
            this.mediaDestination
        ].forEach((node) => {
            try {
                node?.disconnect();
            } catch {
                // Nodes may already be disconnected after browser lifecycle events.
            }
        });

        this.master = null;
        this.compressor = null;
        this.delay = null;
        this.delayFeedback = null;
        this.delayWet = null;
        this.delayFilter = null;
        this.noiseFilter = null;
        this.noiseGain = null;
        this.noiseSource = null;
        this.shaper = null;
        this.mediaDestination = null;
        this.saturatorAmount = null;
    }

    createVoices() {
        const ctx = this.context;

        for (let i = 0; i < MAX_VOICES; i++) {
            const carrier = ctx.createOscillator();
            const modulator = ctx.createOscillator();
            const modGain = ctx.createGain();
            const filter = ctx.createBiquadFilter();
            const panner = ctx.createStereoPanner();
            const gain = ctx.createGain();
            const delaySend = ctx.createGain();

            carrier.type = i % 2 === 0 ? 'sine' : 'triangle';
            modulator.type = 'sine';
            filter.type = i % 3 === 0 ? 'bandpass' : 'lowpass';
            filter.Q.value = 2.2;
            gain.gain.value = 0.0001;
            delaySend.gain.value = 0.08;

            modulator.connect(modGain);
            modGain.connect(carrier.frequency);
            carrier.connect(filter);
            filter.connect(panner);
            panner.connect(gain);
            gain.connect(this.master);
            gain.connect(delaySend);
            delaySend.connect(this.delay);

            carrier.start();
            modulator.start();
            this.voices.push({ carrier, modulator, modGain, filter, panner, gain, delaySend });
        }
    }

    createNoiseBed() {
        const ctx = this.context;
        const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = buffer.getChannelData(0);

        for (let i = 0; i < data.length; i++) {
            data[i] = (Math.random() * 2 - 1) * 0.45;
        }

        this.noiseSource = ctx.createBufferSource();
        this.noiseSource.buffer = buffer;
        this.noiseSource.loop = true;

        this.noiseFilter = ctx.createBiquadFilter();
        this.noiseFilter.type = 'bandpass';
        this.noiseFilter.frequency.value = 1200;
        this.noiseFilter.Q.value = 4;

        this.noiseGain = ctx.createGain();
        this.noiseGain.gain.value = 0.0001;

        this.noiseSource.connect(this.noiseFilter);
        this.noiseFilter.connect(this.noiseGain);
        this.noiseGain.connect(this.master);
        this.noiseGain.connect(this.delay);
        this.noiseSource.start();
    }

    update(params = {}) {
        this.latestParams = params;
        if (!this.started || !this.context) return;

        const ctx = this.context;
        const now = ctx.currentTime;
        const particleDensity = norm(params.PARTICLE_COUNT ?? 4000, 500, 10000);
        const typeCount = clamp(params.numParticleTypes ?? MAX_VOICES, 1, MAX_VOICES);
        const radius = norm(params.radius ?? 50, 10, 125);
        const flowRate = norm(params.delta_t ?? 0.22, 0.01, 0.35);
        const damping = clamp(params.friction ?? 0.71);
        const pressure = norm(params.repulsion ?? 50, 2, 200);
        const cohesion = norm(params.attraction ?? 0.62, 0.1, 4);
        const tension = norm(params.k ?? 16.57, 1.5, 30);
        const forceSpread = Math.abs(params.forceRange ?? 0.28);
        const forceBias = norm(params.forceBias ?? -0.2, -1, 0);
        const orbitRatio = norm(params.ratio ?? 0, -2, 2);
        const pulseDepth = Math.abs(params.lfoA ?? 0);
        const pulseRate = norm(params.lfoS ?? 0.1, 0.1, 10);
        const drive = norm(params.forceMultiplier ?? 2.33, 0, 5);
        const spectralBalance = norm(params.balance ?? 0.79, 0.01, 1.5);
        const foldOffset = norm(params.forceOffset ?? 0, -1, 1);

        const activeVoices = Math.max(1, Math.round(typeCount));
        const baseFrequency = 34 + radius * 72 + forceBias * 32;
        const masterLevel = 0.12 + drive * 0.08 + particleDensity * 0.04;
        const filterBase = 180 + spectralBalance * 3200 + radius * 900 + pressure * 700;
        const q = 0.8 + cohesion * 8 + (1 - damping) * 3;
        const fmDepth = 8 + pressure * 90 + drive * 75 + forceSpread * 55;
        const pulse = 0.65 + Math.sin(now * (0.4 + pulseRate * 8)) * pulseDepth * 0.25;

        setParam(this.master.gain, clamp(masterLevel * pulse, 0.0001, 0.26), now, 0.06);
        setParam(this.delay.delayTime, 0.06 + (1 - damping) * 0.32 + orbitRatio * 0.18, now, 0.08);
        setParam(this.delayFeedback.gain, clamp(0.14 + forceSpread * 0.22 + drive * 0.16 + pulseDepth * 0.12, 0.05, 0.68), now, 0.08);
        setParam(this.delayWet.gain, clamp(0.04 + spectralBalance * 0.12 + forceSpread * 0.12, 0.02, 0.26), now, 0.06);
        setParam(this.delayFilter.frequency, 600 + spectralBalance * 4200 + damping * 900, now, 0.06);
        setParam(this.noiseFilter.frequency, 450 + tension * 4200 + foldOffset * 1100, now, 0.05);
        setParam(this.noiseFilter.Q, 1.5 + cohesion * 10 + forceSpread * 5, now, 0.05);
        setParam(this.noiseGain.gain, clamp(0.008 + particleDensity * 0.035 + pressure * 0.022, 0.0001, 0.08), now, 0.05);

        const nextSaturatorAmount = 1 + drive * 2.6 + pressure * 1.4;
        if (this.saturatorAmount === null || Math.abs(nextSaturatorAmount - this.saturatorAmount) > 0.08) {
            this.shaper.curve = makeSaturator(nextSaturatorAmount);
            this.saturatorAmount = nextSaturatorAmount;
        }

        this.voices.forEach((voice, index) => {
            const isActive = index < activeVoices;
            const ratioSpread = 0.76 + orbitRatio * 0.62;
            const frequency = baseFrequency * VOICE_RATIOS[index] * (1 + tension * 0.08 * index) * ratioSpread;
            const voiceGain = isActive ? (0.28 / activeVoices) * (0.55 + cohesion * 0.45) : 0.0001;
            const pan = activeVoices === 1 ? 0 : (index / (activeVoices - 1)) * 1.7 - 0.85;

            setParam(voice.carrier.frequency, clamp(frequency, 22, 1200), now, 0.06);
            setParam(voice.modulator.frequency, clamp(frequency * (0.33 + foldOffset * 1.8 + index * 0.08), 0.4, 2400), now, 0.06);
            setParam(voice.modGain.gain, clamp(fmDepth * (0.65 + index * 0.08), 0, 260), now, 0.05);
            setParam(voice.filter.frequency, clamp(filterBase * (0.65 + index * 0.18), 80, 9000), now, 0.05);
            setParam(voice.filter.Q, clamp(q, 0.2, 18), now, 0.05);
            setParam(voice.panner.pan, clamp(pan + (orbitRatio - 0.5) * 0.35, -1, 1), now, 0.08);
            setParam(voice.gain.gain, voiceGain, now, 0.08);
            setParam(voice.delaySend.gain, clamp(0.035 + forceSpread * 0.16 + pulseDepth * 0.12, 0.02, 0.25), now, 0.06);
        });
    }

    triggerRegenerate() {
        if (!this.started || !this.context) return;
        this.spawnGrainBurst(10, 0.16);
    }

    triggerReset() {
        if (!this.started || !this.context) return;
        const now = this.context.currentTime;
        setParam(this.master.gain, 0.02, now, 0.025);
        window.setTimeout(() => this.update(this.latestParams || {}), 150);
    }

    getRecordingStream() {
        return this.mediaDestination?.stream || null;
    }

    startGrainScheduler() {
        clearInterval(this.grainTimer);
        this.grainTimer = window.setInterval(() => {
            if (!this.started || !this.latestParams) return;

            const density = norm(this.latestParams.PARTICLE_COUNT ?? 4000, 500, 10000);
            const flowRate = norm(this.latestParams.delta_t ?? 0.22, 0.01, 0.35);
            const now = this.context.currentTime;
            const interval = 0.18 - density * 0.1 - flowRate * 0.04;

            if (now - this.lastGrainTime >= interval) {
                this.spawnGrainBurst(1 + Math.round(density * 3), 0.045 + flowRate * 0.06);
                this.lastGrainTime = now;
            }
        }, 45);
    }

    spawnGrainBurst(count, duration) {
        const ctx = this.context;
        const params = this.latestParams || {};
        const tension = norm(params.k ?? 16.57, 1.5, 30);
        const spectralBalance = norm(params.balance ?? 0.79, 0.01, 1.5);
        const pressure = norm(params.repulsion ?? 50, 2, 200);

        for (let i = 0; i < count; i++) {
            const burst = ctx.createBufferSource();
            const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
            const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
            const data = buffer.getChannelData(0);

            for (let j = 0; j < length; j++) {
                const envelope = 1 - j / length;
                data[j] = (Math.random() * 2 - 1) * envelope;
            }

            const filter = ctx.createBiquadFilter();
            const gain = ctx.createGain();
            const pan = ctx.createStereoPanner();
            const start = ctx.currentTime + Math.random() * 0.045;

            burst.buffer = buffer;
            filter.type = 'bandpass';
            filter.frequency.setValueAtTime(500 + tension * 5200 + Math.random() * 1200, start);
            filter.Q.setValueAtTime(1.5 + spectralBalance * 8, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.025 + pressure * 0.025, start + 0.006);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
            pan.pan.setValueAtTime(Math.random() * 2 - 1, start);

            burst.connect(filter);
            filter.connect(pan);
            pan.connect(gain);
            gain.connect(this.master);
            gain.connect(this.delay);
            burst.start(start);
            burst.stop(start + duration + 0.02);
        }
    }
}

export const audioEngine = new CellFlowAudioEngine();
