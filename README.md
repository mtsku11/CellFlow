# CellFlow AV

CellFlow AV is an experimental browser-based audiovisual instrument built from the
CellFlow particle-life simulation. Dense particle structures behave as living
visual organisms, while a Web Audio engine listens to the simulation and turns
their scale, movement, and density into sound.

Live version:

https://mtsku11.github.io/CellFlow/

## Audiovisual System

The project extends the original CellFlow simulator with a real-time sound engine.
The audio is not just a background layer: it receives control data from the same
parameters that shape the visual system and also analyzes the particle field
directly.

The strongest mapping is organism-driven:

- Large, dense, well-defined organisms trigger slow low-pitched envelopes.
- Medium organisms trigger shorter, higher pitched gestures.
- Small organisms trigger high granular events.
- Organism speed affects envelope length and rhythm.
- Diffuse particle clouds, with no coherent organisms, raise a filtered noise
  layer instead of pitched material.

The sound engine uses Web Audio oscillators, FM-style modulation, resonant
filtering, granular bursts, stereo motion, delay feedback, saturation, and
compression. The constant low drone has been reduced so that foreground pitched
events come primarily from visible organism structures.

## Controls

The control labels are written as audiovisual parameters rather than purely
simulation parameters.

- `Population Richness` changes particle count and sonic density.
- `Voice Families` changes visual particle families and the harmonic palette.
- `Resonance Radius` changes interaction distance and filter/resonance behavior.
- `Flow Rate` changes simulation speed and rhythmic activity.
- `Motion Damping` changes visual inertia and envelope pacing.
- `Scatter Pressure` pushes particles apart and increases noisy dispersion.
- `Cohesion Pull` encourages organism formation and stronger pitched gestures.
- `Membrane Tension` changes organism shape and spectral tension.
- `Interaction Spread` and `Interaction Bias` reshape the force field.
- `Orbit Tuning` shifts orbital behavior and pitch relationships.
- `Shared Pulse Depth` and `Shared Pulse Rate` drive a shared visual/audio LFO.
- `Flow Drive` increases visual force and modulation intensity.
- `Spectral Balance` and `Timbre Fold` shape the audio color.

Use `Start sound` to enable the audio engine. Browsers require a user gesture
before audio can start.

## Keyboard

- `1` to `8`: load presets
- `Space`: regenerate the force matrix
- `X`: rotate field radii
- `C`: expand or collapse the controls

## Local Development

This is a static browser project. Run it from any local static server:

```sh
python3 -m http.server 8080
```

Then open:

```text
http://localhost:8080/
```

The main files are:

- `index.html`: interface and controls
- `main.js`: simulation loop, UI wiring, recording, and organism analysis updates
- `audioEngine.js`: Web Audio synthesis and organism-to-sound mapping
- `gpuSetup.js`: WebGPU setup and particle simulation support
- `simShader.js`, `renderShader.js`: simulation and luminous particle shaders
- `presets/`: saved parameter states

## Credits

This audiovisual fork builds on the CellFlow simulator by Spherical Sound Society,
which itself develops ideas from Jeffrey Ventrella's Clusters and Tom Mohr's
Particle Life.
