const BPM_CONFIG = {
    large:  { minBPM: 15, maxBPM: 90 },
    medium: { minBPM: 20, maxBPM: 140 },
    small:  { minBPM: 30, maxBPM: 180 }
};

const STATE_NAMES = {
    large:  ['rest', 'sparse', 'pulse', 'dense', 'fill'],
    medium: ['rest', 'groove', 'pulse', 'groove+', 'fill'],
    small:  ['scatter', 'sparse', 'rapid', 'cluster', 'burst']
};

const TRANSITION_MATRICES = {
    large: [
        [0.65, 0.25, 0.07, 0.02, 0.01],
        [0.30, 0.45, 0.18, 0.05, 0.02],
        [0.10, 0.25, 0.45, 0.15, 0.05],
        [0.05, 0.15, 0.30, 0.40, 0.10],
        [0.15, 0.20, 0.30, 0.25, 0.10]
    ],
    medium: [
        [0.30, 0.35, 0.20, 0.10, 0.05],
        [0.15, 0.35, 0.30, 0.15, 0.05],
        [0.08, 0.20, 0.40, 0.22, 0.10],
        [0.05, 0.15, 0.25, 0.40, 0.15],
        [0.10, 0.15, 0.25, 0.30, 0.20]
    ],
    small: [
        [0.15, 0.25, 0.30, 0.20, 0.10],
        [0.10, 0.20, 0.35, 0.25, 0.10],
        [0.05, 0.15, 0.30, 0.30, 0.20],
        [0.05, 0.10, 0.25, 0.35, 0.25],
        [0.10, 0.15, 0.25, 0.30, 0.20]
    ]
};

const STATE_MODIFIERS = {
    large: [
        { fireProbability: 0.08, grainMult: 0.1,  pulseMult: 0.3, velocityMult: 0.3 },
        { fireProbability: 0.35, grainMult: 0.4,  pulseMult: 0.6, velocityMult: 0.6 },
        { fireProbability: 0.70, grainMult: 1.0,  pulseMult: 1.0, velocityMult: 1.0 },
        { fireProbability: 0.88, grainMult: 1.6,  pulseMult: 1.4, velocityMult: 1.2 },
        { fireProbability: 0.95, grainMult: 2.4,  pulseMult: 2.0, velocityMult: 1.4 }
    ],
    medium: [
        { fireProbability: 0.12, grainMult: 0.15, pulseMult: 0.4, velocityMult: 0.4 },
        { fireProbability: 0.55, grainMult: 0.7,  pulseMult: 0.8, velocityMult: 0.8 },
        { fireProbability: 0.75, grainMult: 1.0,  pulseMult: 1.0, velocityMult: 1.0 },
        { fireProbability: 0.88, grainMult: 1.5,  pulseMult: 1.3, velocityMult: 1.2 },
        { fireProbability: 0.96, grainMult: 2.2,  pulseMult: 1.8, velocityMult: 1.4 }
    ],
    small: [
        { fireProbability: 0.30, grainMult: 0.5,  pulseMult: 0.7, velocityMult: 0.7 },
        { fireProbability: 0.55, grainMult: 0.8,  pulseMult: 1.0, velocityMult: 0.9 },
        { fireProbability: 0.78, grainMult: 1.2,  pulseMult: 1.4, velocityMult: 1.1 },
        { fireProbability: 0.90, grainMult: 1.8,  pulseMult: 1.8, velocityMult: 1.3 },
        { fireProbability: 0.97, grainMult: 2.6,  pulseMult: 2.2, velocityMult: 1.5 }
    ]
};

function pickNext(row) {
    let r = Math.random();
    for (let i = 0; i < row.length; i++) {
        r -= row[i];
        if (r <= 0) return i;
    }
    return row.length - 1;
}

export class MarkovRhythm {
    constructor(sizeClass) {
        this._sizeClass = sizeClass;
        this._state = 0;
        this._accumulator = 0;
        this._lastBeatTime = null;
        this._bpmConfig = BPM_CONFIG[sizeClass];
        this._states = STATE_NAMES[sizeClass];
        this._matrix = TRANSITION_MATRICES[sizeClass];
        this._modifiers = STATE_MODIFIERS[sizeClass];
    }

    tick(speedNorm, nowSecs) {
        const bpm = this._bpmConfig.minBPM + speedNorm * (this._bpmConfig.maxBPM - this._bpmConfig.minBPM);
        const beatInterval = 60 / bpm;
        const beats = [];

        if (this._lastBeatTime === null) {
            this._lastBeatTime = nowSecs;
            this._accumulator = 0;
            return beats;
        }

        const delta = nowSecs - this._lastBeatTime;
        this._accumulator += delta;
        this._lastBeatTime = nowSecs;

        while (this._accumulator >= beatInterval) {
            this._accumulator -= beatInterval;
            this._state = pickNext(this._matrix[this._state]);
            const mods = this._modifiers[this._state];
            const fire = Math.random() < mods.fireProbability;
            beats.push({
                fire,
                mods: {
                    grainMult:    mods.grainMult,
                    pulseMult:    mods.pulseMult,
                    velocityMult: mods.velocityMult
                }
            });
        }

        return beats;
    }

    reset() {
        this._lastBeatTime = null;
        this._state = 0;
        this._accumulator = 0;
    }

    getState() {
        return this._states[this._state];
    }
}
