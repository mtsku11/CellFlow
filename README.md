# CellFlow

CellFlow is a novel organic life particle system that takes the simulation to new levels, building upon the foundational concepts of Clusters by Jeffrey Ventrella and Particle Life by Tom Mohr.

In CellFlow, it have been introduced core algorithmic differences that evolve the original particle interaction, leading to more complex and emergent behaviors.

I have documented all the changes of the core algoridtms in this video:

https://www.youtube.com/watch?v=E8vvSu8PZmI

You can play with the CellFlow simulator directly on the web

https://spherical-sound-society.github.io/CellFlow/

This fork adds an experimental Web Audio engine for audiovisual performance. Population Richness now increases sonic population through upper partials, a denser grain field, wider delay sends, and brighter filtered noise. Shared Pulse Depth and Shared Pulse Rate drive the same LFO relationship in the cell flow and the sound engine, modulating amplitude, filter movement, FM depth, delay time, and stereo motion.

The sound engine now reads lightweight snapshots from the WebGPU particle buffer and analyzes dense connected regions as visual organisms. Large organisms trigger slow low envelopes, medium organisms trigger higher pitched envelopes, and small organisms trigger short high grains. Organism speed controls envelope length and event rhythm, while dispersed cloud states raise the filtered noise layer.
