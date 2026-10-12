// Observation markers: shape 0 = disc (survey sample), 1 = ring (station),
// 2 = diamond (cast), all with a dark ink rim so they read on sand and sea.
varying vec3 vColor; varying float vShape; varying float vPx; varying float vRim;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = vShape > 1.5 ? abs(c.x) + abs(c.y) : length(c);
  if (r > 1.0) discard;
  vec3 ink = vec3(0.035, 0.06, 0.08);
  float edge = 1.0 - vRim;
  if (vShape > 0.5 && vShape < 1.5) {
    // a ring: hollow, inked on both rims so it reads on sand and on sea
    if (r < 0.34) discard;
    gl_FragColor = vec4((r > edge || r < 0.34 + vRim) ? ink : vColor, 1.0);
  } else {
    gl_FragColor = vec4(r > edge ? ink : vColor, 1.0);
  }
}
