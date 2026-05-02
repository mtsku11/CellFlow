const VOICE_RATIOS = [1, 1.125, 1.25, 1.5, 1.75, 2.25];
const MAX_VOICES = VOICE_RATIOS.length;
const CONTROL_UPDATE_MS = 33;

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const norm = (value, min, max) => clamp((value - min) / (max - min));
const ORGANISM_CLASS_ORDER = ['large', 'medium', 'small'];

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
        this.controlTimer = null;
        this.latestParams = null;
        this.latestOrganismAnalysis = null;
        this.lastGrainTime = 0;
        this.lastOrganismEvents = {
            large: 0,
            medium: 0,
            small: 0
        };
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
        this.startControlLoop();
    }

    stop() {
        if (!this.started || !this.context) return;

        const now = this.context.currentTime;
        setParam(this.master.gain, 0.0001, now, 0.08);
        clearInterval(this.grainTimer);
        clearInterval(this.controlTimer);
        this.grainTimer = null;
        this.controlTimer = null;

        window.setTimeout(() => {
            this.voices.forEach((voice) => {
                voice.carrier.stop();
                voice.modulator.stop();
                voice.partial.stop();
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
        this.latestOrganismAnalysis = null;
    }

    createVoices() {
        const ctx = this.context;

        for (let i = 0; i < MAX_VOICES; i++) {
            const carrier = ctx.createOscillator();
            const modulator = ctx.createOscillator();
            const modGain = ctx.createGain();
            const partial = ctx.createOscillator();
            const partialFilter = ctx.createBiquadFilter();
            const partialGain = ctx.createGain();
            const filter = ctx.createBiquadFilter();
            const panner = ctx.createStereoPanner();
            const gain = ctx.createGain();
            const delaySend = ctx.createGain();

            carrier.type = i % 2 === 0 ? 'sine' : 'triangle';
            modulator.type = 'sine';
            partial.type = i % 2 === 0 ? 'triangle' : 'sine';
            partialFilter.type = 'bandpass';
            partialFilter.frequency.value = 1200;
            partialFilter.Q.value = 2;
            filter.type = i % 3 === 0 ? 'bandpass' : 'lowpass';
            filter.Q.value = 2.2;
            partialGain.gain.value = 0.0001;
            gain.gain.value = 0.0001;
            delaySend.gain.value = 0.08;

            modulator.connect(modGain);
            modGain.connect(carrier.frequency);
            partial.connect(partialFilter);
            partialFilter.connect(partialGain);
            carrier.connect(filter);
            filter.connect(panner);
            partialGain.connect(panner);
            panner.connect(gain);
            gain.connect(this.master);
            gain.connect(delaySend);
            delaySend.connect(this.delay);

            carrier.start();
            modulator.start();
            partial.start();
            this.voices.push({
                carrier,
                modulator,
                modGain,
                partial,
                partialFilter,
                partialGain,
                filter,
                panner,
                gain,
                delaySend
            });
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
        const lfoDepth = params.lfoA ?? 0;
        const pulseDepth = Math.abs(lfoDepth);
        const drive = norm(params.forceMultiplier ?? 2.33, 0, 5);
        const spectralBalance = norm(params.balance ?? 0.79, 0.01, 1.5);
        const foldOffset = norm(params.forceOffset ?? 0, -1, 1);
        const sharedLfo = this.getSharedLfo(params);
        const unipolarLfo = (sharedLfo + 1) * 0.5;
        const richness = Math.pow(particleDensity, 0.72);
        const analysis = this.latestOrganismAnalysis || {};
        const organismMass = analysis.organismMassRatio ?? 0;
        const classMassRatio = analysis.classMassRatio || {};
        const largePresence = clamp((classMassRatio.large ?? 0) * 8.5, 0, 1);
        const cloudRatio = analysis.cloudRatio ?? 1;
        const motionRatio = analysis.motionRatio ?? 0;
        const organismPresence = clamp(organismMass * 3.2, 0, 1);

        const activeVoices = Math.max(1, Math.round(typeCount));
        const baseFrequency = 34 + radius * 72 + forceBias * 32;
        const masterLevel = 0.105 + drive * 0.045 + richness * 0.025 + cloudRatio * 0.035;
        const filterBase = 180 + spectralBalance * 3000 + radius * 900 + pressure * 620 + unipolarLfo * pulseDepth * 1600;
        const q = 0.8 + cohesion * 8 + (1 - damping) * 3;
        const fmDepth = 7 + pressure * 72 + drive * 66 + forceSpread * 48 + richness * 70;
        const pulse = 0.76 + sharedLfo * 0.24;

        setParam(this.master.gain, clamp(masterLevel * pulse, 0.0001, 0.24), now, 0.06);
        setParam(this.delay.delayTime, 0.06 + (1 - damping) * 0.32 + orbitRatio * 0.18 + unipolarLfo * pulseDepth * 0.045, now, 0.08);
        setParam(this.delayFeedback.gain, clamp(0.14 + forceSpread * 0.22 + drive * 0.16 + pulseDepth * 0.12, 0.05, 0.68), now, 0.08);
        setParam(this.delayWet.gain, clamp(0.04 + spectralBalance * 0.1 + forceSpread * 0.1 + richness * 0.045, 0.02, 0.27), now, 0.06);
        setParam(this.delayFilter.frequency, 600 + spectralBalance * 3900 + damping * 900 + unipolarLfo * pulseDepth * 1300, now, 0.06);
        setParam(this.noiseFilter.frequency, 380 + tension * 3600 + foldOffset * 1000 + richness * 1200 + cloudRatio * 1600, now, 0.05);
        setParam(this.noiseFilter.Q, 1.2 + cohesion * 7 + forceSpread * 4 - cloudRatio * 0.6, now, 0.05);
        setParam(this.noiseGain.gain, clamp(0.002 + cloudRatio * 0.075 + motionRatio * 0.025 + pressure * 0.006, 0.0001, 0.09), now, 0.08);

        const nextSaturatorAmount = 1 + drive * 2.2 + pressure * 1.1 + richness * 0.55;
        if (this.saturatorAmount === null || Math.abs(nextSaturatorAmount - this.saturatorAmount) > 0.08) {
            this.shaper.curve = makeSaturator(nextSaturatorAmount);
            this.saturatorAmount = nextSaturatorAmount;
        }

        this.voices.forEach((voice, index) => {
            const isActive = index < activeVoices;
            const ratioSpread = 0.76 + orbitRatio * 0.62;
            const lfoBend = 1 + sharedLfo * (0.006 + index * 0.003);
            const frequency = baseFrequency * VOICE_RATIOS[index] * (1 + tension * 0.08 * index) * ratioSpread * lfoBend;
            const voiceGain = isActive ? (0.045 / activeVoices) * (0.035 + cohesion * 0.11 * organismPresence + organismPresence * 0.78 + largePresence * 0.28 + motionRatio * 0.24) : 0.0001;
            const partialGain = isActive ? (0.002 + richness * 0.012) * organismPresence * (1 + index * 0.08) * (0.7 + unipolarLfo * pulseDepth * 0.45) : 0.0001;
            const partialFrequency = frequency * (2 + index * 0.35 + spectralBalance * 1.1 + richness * 0.9);
            const pan = activeVoices === 1 ? 0 : (index / (activeVoices - 1)) * 1.7 - 0.85;

            setParam(voice.carrier.frequency, clamp(frequency, 22, 1200), now, 0.06);
            setParam(voice.modulator.frequency, clamp(frequency * (0.33 + foldOffset * 1.8 + index * 0.08 + unipolarLfo * pulseDepth * 0.28), 0.4, 2400), now, 0.06);
            setParam(voice.modGain.gain, clamp(fmDepth * (0.62 + index * 0.07 + unipolarLfo * pulseDepth * 0.22), 0, 260), now, 0.05);
            setParam(voice.partial.frequency, clamp(partialFrequency, 48, 5200), now, 0.06);
            setParam(voice.partialFilter.frequency, clamp(partialFrequency * (1.1 + tension * 0.3), 90, 9000), now, 0.05);
            setParam(voice.partialFilter.Q, clamp(1.2 + spectralBalance * 6 + richness * 2.5, 0.4, 12), now, 0.05);
            setParam(voice.partialGain.gain, clamp(partialGain, 0.0001, 0.055), now, 0.07);
            setParam(voice.filter.frequency, clamp(filterBase * (0.65 + index * 0.18), 80, 9000), now, 0.05);
            setParam(voice.filter.Q, clamp(q, 0.2, 18), now, 0.05);
            setParam(voice.panner.pan, clamp(pan + (orbitRatio - 0.5) * 0.35 + sharedLfo * 0.18, -1, 1), now, 0.08);
            setParam(voice.gain.gain, voiceGain, now, 0.08);
            setParam(voice.delaySend.gain, clamp(0.035 + forceSpread * 0.13 + pulseDepth * 0.1 + richness * 0.055, 0.02, 0.25), now, 0.06);
        });
    }

    updateOrganisms(analysis) {
        this.latestOrganismAnalysis = analysis;
        if (!this.started || !this.context) return;

        this.update(this.latestParams || {});

        const now = this.context.currentTime;
        const organismsByClass = ORGANISM_CLASS_ORDER.reduce((groups, sizeClass) => {
            groups[sizeClass] = analysis.organisms
                .filter((organism) => organism.sizeClass === sizeClass)
                .sort((a, b) => b.mass - a.mass);
            return groups;
        }, {});

        ORGANISM_CLASS_ORDER.forEach((sizeClass) => {
            const organisms = organismsByClass[sizeClass];
            if (!organisms.length) return;

            const representative = organisms[0];
            const cooldown = this.getOrganismCooldown(sizeClass, representative.speedNorm, organisms.length);
            if (now - this.lastOrganismEvents[sizeClass] < cooldown) return;

            organisms.slice(0, Math.min(2, organisms.length)).forEach((organism, index) => {
                this.spawnOrganismEnvelope(organism, index * 0.035);
            });
            this.lastOrganismEvents[sizeClass] = now;
        });
    }

    getOrganismCooldown(sizeClass, speedNorm, count) {
        const densityPush = Math.min(0.24, count * 0.035);
        if (sizeClass === 'large') return clamp(3.4 - speedNorm * 2.15 - densityPush, 0.68, 3.6);
        if (sizeClass === 'medium') return clamp(1.35 - speedNorm * 0.9 - densityPush, 0.28, 1.45);
        return clamp(0.42 - speedNorm * 0.22 - densityPush, 0.18, 0.48);
    }

    getOrganismSoundShape(organism) {
        const speed = clamp(organism.speedNorm ?? 0);
        const yPitch = 1 - clamp(organism.yNorm ?? 0.5);
        const mass = clamp((organism.massRatio ?? 0) * 8);
        const params = this.latestParams || {};
        const tension = norm(params.k ?? 16.57, 1.5, 30);
        const spectralBalance = norm(params.balance ?? 0.79, 0.01, 1.5);

        if (organism.sizeClass === 'large') {
            return {
                baseFrequency: 28 + yPitch * 34 + mass * 18,
                duration: 4.8 - speed * 3.6,
                attackRatio: 0.34 - speed * 0.22,
                gain: 0.095,
                modRatio: 0.24 + speed * 1.2,
                modDepth: 55 + mass * 115 + tension * 65,
                filterRatio: 2.8 + spectralBalance * 2.3,
                grainCount: 8 + Math.round(mass * 16),
                grainDuration: 0.34 - speed * 0.22
            };
        }

        if (organism.sizeClass === 'medium') {
            return {
                baseFrequency: 145 + yPitch * 380 + mass * 120,
                duration: 1.65 - speed * 1.05,
                attackRatio: 0.18 - speed * 0.1,
                gain: 0.062,
                modRatio: 0.72 + speed * 2.1,
                modDepth: 42 + mass * 90 + tension * 80,
                filterRatio: 2.0 + spectralBalance * 2.8,
                grainCount: 7 + Math.round(mass * 18),
                grainDuration: 0.13 - speed * 0.07
            };
        }

        return {
            baseFrequency: 980 + yPitch * 4200 + mass * 800,
            duration: 0.42 - speed * 0.28,
            attackRatio: 0.05,
            gain: 0.028,
            modRatio: 1.7 + speed * 5.5,
            modDepth: 25 + mass * 55 + tension * 90,
            filterRatio: 1.25 + spectralBalance * 1.7,
            grainCount: 6 + Math.round(mass * 14),
            grainDuration: 0.038 - speed * 0.018
        };
    }

    spawnOrganismEnvelope(organism, offset = 0) {
        const ctx = this.context;
        const shape = this.getOrganismSoundShape(organism);
        const speed = clamp(organism.speedNorm ?? 0);
        const start = ctx.currentTime + offset;
        const duration = Math.max(0.055, shape.duration);
        const attack = Math.max(0.006, duration * clamp(shape.attackRatio, 0.035, 0.42));
        const releaseStart = start + Math.max(attack + 0.012, duration * (0.36 + (1 - speed) * 0.28));
        const end = start + duration;
        const baseFrequency = clamp(shape.baseFrequency, 24, 6400);
        const peakGain = shape.gain * (0.72 + clamp(organism.massRatio * 8) * 0.6);
        const panValue = clamp((organism.xNorm ?? 0.5) * 2 - 1, -0.92, 0.92);

        const carrier = ctx.createOscillator();
        const modulator = ctx.createOscillator();
        const modGain = ctx.createGain();
        const filter = ctx.createBiquadFilter();
        const panner = ctx.createStereoPanner();
        const amp = ctx.createGain();
        const delaySend = ctx.createGain();

        carrier.type = organism.sizeClass === 'large' ? 'sawtooth' : organism.sizeClass === 'medium' ? 'triangle' : 'sine';
        modulator.type = organism.sizeClass === 'small' ? 'square' : 'sine';
        carrier.frequency.setValueAtTime(baseFrequency, start);
        carrier.frequency.exponentialRampToValueAtTime(clamp(baseFrequency * (0.92 + speed * 0.26), 24, 7200), end);
        modulator.frequency.setValueAtTime(clamp(baseFrequency * shape.modRatio, 0.2, 9000), start);
        modGain.gain.setValueAtTime(shape.modDepth * (0.65 + speed * 0.55), start);
        filter.type = organism.sizeClass === 'large' ? 'lowpass' : 'bandpass';
        filter.frequency.setValueAtTime(clamp(baseFrequency * shape.filterRatio, 70, 12000), start);
        filter.frequency.exponentialRampToValueAtTime(clamp(baseFrequency * (shape.filterRatio + 1.2 + speed * 3.4), 90, 13000), releaseStart);
        filter.Q.setValueAtTime(organism.sizeClass === 'large' ? 4.8 : 7.5 + speed * 5.5, start);
        panner.pan.setValueAtTime(panValue, start);
        delaySend.gain.setValueAtTime(organism.sizeClass === 'large' ? 0.18 : 0.11 + speed * 0.1, start);

        amp.gain.setValueAtTime(0.0001, start);
        amp.gain.exponentialRampToValueAtTime(clamp(peakGain, 0.002, 0.16), start + attack);
        amp.gain.setTargetAtTime(0.0001, releaseStart, Math.max(0.025, (end - releaseStart) * 0.42));

        modulator.connect(modGain);
        modGain.connect(carrier.frequency);
        carrier.connect(filter);
        filter.connect(panner);
        panner.connect(amp);
        amp.connect(this.master);
        amp.connect(delaySend);
        delaySend.connect(this.delay);

        carrier.start(start);
        modulator.start(start);
        carrier.stop(end + 0.08);
        modulator.stop(end + 0.08);

        window.setTimeout(() => {
            [carrier, modulator, modGain, filter, panner, amp, delaySend].forEach((node) => {
                try {
                    node.disconnect();
                } catch {
                    // One-shot nodes may already be disconnected.
                }
            });
        }, (duration + offset + 0.18) * 1000);

        this.spawnOrganismGrains(organism, baseFrequency, shape, offset);
    }

    spawnOrganismGrains(organism, baseFrequency, shape, offset = 0) {
        const ctx = this.context;
        const speed = clamp(organism.speedNorm ?? 0);
        const panCenter = clamp((organism.xNorm ?? 0.5) * 2 - 1, -0.9, 0.9);
        const grainCount = Math.min(organism.sizeClass === 'small' ? 28 : 42, shape.grainCount);
        const spread = organism.sizeClass === 'large' ? 0.72 : organism.sizeClass === 'medium' ? 1.15 : 2.6;
        const windowDuration = Math.max(0.06, shape.duration * (organism.sizeClass === 'large' ? 0.72 : 0.48));

        for (let i = 0; i < grainCount; i++) {
            const duration = Math.max(0.012, shape.grainDuration * (0.72 + Math.random() * 0.7));
            const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
            const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
            const data = buffer.getChannelData(0);
            const phaseSkew = Math.random() * Math.PI * 2;

            for (let j = 0; j < length; j++) {
                const position = j / Math.max(1, length - 1);
                const envelope = Math.sin(Math.PI * position);
                const fizz = Math.random() * 2 - 1;
                const pulse = Math.sin(phaseSkew + position * Math.PI * 2 * (2 + speed * 9));
                data[j] = (fizz * 0.74 + pulse * 0.26) * envelope;
            }

            const source = ctx.createBufferSource();
            const filter = ctx.createBiquadFilter();
            const gain = ctx.createGain();
            const panner = ctx.createStereoPanner();
            const start = ctx.currentTime + offset + Math.random() * windowDuration;
            const classPitch = organism.sizeClass === 'large' ? 0.35 + Math.random() * 1.3 : organism.sizeClass === 'medium' ? 0.9 + Math.random() * 2.8 : 1.4 + Math.random() * 5.2;
            const frequency = clamp(baseFrequency * classPitch * (1 + speed * spread), 28, 13500);

            source.buffer = buffer;
            filter.type = organism.sizeClass === 'large' ? 'lowpass' : 'bandpass';
            filter.frequency.setValueAtTime(frequency, start);
            filter.Q.setValueAtTime(organism.sizeClass === 'large' ? 3.2 : 8 + speed * 7, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(
                clamp(shape.gain * (organism.sizeClass === 'small' ? 0.28 : 0.18) * (0.55 + Math.random()), 0.001, 0.052),
                start + Math.min(0.012, duration * 0.32)
            );
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
            panner.pan.setValueAtTime(clamp(panCenter + (Math.random() * 2 - 1) * 0.42, -1, 1), start);

            source.connect(filter);
            filter.connect(panner);
            panner.connect(gain);
            gain.connect(this.master);
            gain.connect(this.delay);
            source.start(start);
            source.stop(start + duration + 0.02);

            window.setTimeout(() => {
                [source, filter, gain, panner].forEach((node) => {
                    try {
                        node.disconnect();
                    } catch {
                        // One-shot nodes may already be disconnected.
                    }
                });
            }, (offset + windowDuration + duration + 0.08) * 1000);
        }
    }

    getSharedLfo(params = {}) {
        const depth = params.lfoA ?? 0;
        const rate = params.lfoS ?? 0.1;
        const time = performance.now() / 1000;
        return depth * Math.sin(2 * Math.PI * rate * time);
    }

    startControlLoop() {
        clearInterval(this.controlTimer);
        this.controlTimer = window.setInterval(() => {
            if (!this.started || !this.latestParams) return;
            this.update(this.latestParams);
        }, CONTROL_UPDATE_MS);
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
            const lfoDepth = Math.abs(this.latestParams.lfoA ?? 0);
            const cloudRatio = this.latestOrganismAnalysis?.cloudRatio ?? 1;
            const organismMass = this.latestOrganismAnalysis?.organismMassRatio ?? 0;
            const now = this.context.currentTime;
            const richness = Math.pow(density, 0.72);
            const interval = 0.32 - cloudRatio * 0.18 - richness * 0.06 - flowRate * 0.03 - lfoDepth * 0.012;

            if (now - this.lastGrainTime >= interval) {
                const count = Math.max(1, Math.round(1 + cloudRatio * richness * 5 - organismMass * 2));
                this.spawnGrainBurst(count, 0.025 + cloudRatio * 0.05 + flowRate * 0.035 + richness * 0.01);
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
        const density = norm(params.PARTICLE_COUNT ?? 4000, 500, 10000);
        const lfoValue = this.getSharedLfo(params);
        const richness = Math.pow(density, 0.72);

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
            filter.frequency.setValueAtTime(clamp(420 + tension * 4700 + richness * 2600 + lfoValue * 700 + Math.random() * 1300, 80, 9500), start);
            filter.Q.setValueAtTime(1.4 + spectralBalance * 7 + richness * 2.5, start);
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.012 + pressure * 0.018 + richness * 0.018, start + 0.006);
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
