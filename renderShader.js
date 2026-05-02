export function getRenderShaderCode(numParticleTypes, canvasWidth, canvasHeight, particleColors) {
  let colorAssignments = '';
  for (let i = 0; i < numParticleTypes; i++) {
    colorAssignments += `          if (p.ptype == ${i}u) { c = ${particleColors[i]}; }\n`;
  }
  colorAssignments += `          if (p.ptype >= ${numParticleTypes}u) { c = vec3f(1.0, 1.0, 0.0); } // Amarillo para tipos fuera de rango\n`;

  return `
    struct Particle {
      pos: vec2f,
      vel: vec2f,
      acc: vec2f,
      ptype: u32,
      pad: u32
    };

    @group(0) @binding(0) var<storage, read> particles: array<Particle>;

    struct VSOut {
      @builtin(position) pos: vec4f,
      @location(0) color: vec3f,
      @location(1) local: vec2f
    };

    @vertex
    fn vs_main(@builtin(vertex_index) i: u32) -> VSOut {
      let particleIndex = i / 6u;
      let subIndex = i % 6u;
      let p = particles[particleIndex];
      var c = vec3f(0.5); // Gris por defecto
${colorAssignments}

      var local: vec2f;
      if (subIndex == 0u) { local = vec2f(-1.0, -1.0); }
      else if (subIndex == 1u) { local = vec2f(1.0, -1.0); }
      else if (subIndex == 2u) { local = vec2f(-1.0, 1.0); }
      else if (subIndex == 3u) { local = vec2f(-1.0, 1.0); }
      else if (subIndex == 4u) { local = vec2f(1.0, -1.0); }
      else { local = vec2f(1.0, 1.0); }

      let shortestSide = min(${canvasWidth}.0, ${canvasHeight}.0);
      let glowRadius = clamp(shortestSide * 0.0075, 4.5, 9.0);
      let pixelPos = p.pos + local * glowRadius;

      // Validar límites para evitar dibujar fuera del canvas
      var out: VSOut;
      if (pixelPos.x < -glowRadius || pixelPos.x >= ${canvasWidth}.0 + glowRadius || pixelPos.y < -glowRadius || pixelPos.y >= ${canvasHeight}.0 + glowRadius) {
        out.pos = vec4f(0.0, 0.0, -1.0, 1.0); // Fuera de pantalla (no visible)
      } else {
        out.pos = vec4f((pixelPos.x / ${canvasWidth}.0) * 2.0 - 1.0,
                        (pixelPos.y / ${canvasHeight}.0) * -2.0 + 1.0,
                        0.0, 1.0);
      }
      out.color = c;
      out.local = local;

      return out;
    }

    @fragment
    fn fs_main(in: VSOut) -> @location(0) vec4f {
      let d = length(in.local);
      if (d > 1.0) {
        discard;
      }

      let core = smoothstep(0.24, 0.0, d);
      let halo = pow(max(1.0 - d, 0.0), 2.8);
      let aura = pow(max(1.0 - d * 0.72, 0.0), 5.0) * 0.22;
      let intensity = core * 1.25 + halo * 0.42 + aura;
      let color = in.color * (0.55 + core * 0.8 + halo * 0.45);

      return vec4f(color * intensity, min(core * 0.95 + halo * 0.32 + aura, 0.86));
    }
  `;
}
