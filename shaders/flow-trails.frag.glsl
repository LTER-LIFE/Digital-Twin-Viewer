// Flow trails: high-luminance streaks fading toward the tail and with distance.
uniform float uOpacity;
uniform vec3 uFogColor; uniform vec2 uFogRange;
varying float vFade; varying float vT; varying vec3 vWorld;
void main(){
  // Deliberately NOT the 'speed' colormap used by the drape: that ramp
  // starts near-black, and a dark low-alpha streak is invisible over the
  // bright shallow water where much of the interesting flow is. Trails
  // stay high-luminance at every speed so they read on navy sea, pale
  // flats and satellite imagery alike; magnitude is carried by streak
  // length, alpha and on-screen speed instead of by darkness.
  vec3 col = mix(vec3(0.42, 0.78, 0.98), vec3(1.0, 0.99, 0.94), vT * vT);
  float a = vFade * uOpacity * (0.38 + 0.62 * vT);
  float d = length(vWorld - cameraPosition);
  a *= 1.0 - smoothstep(uFogRange.x, uFogRange.y, d);
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}
