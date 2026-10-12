// Sky dome: gradient, sun disc and halo, and drifting fbm clouds.
uniform vec3 uSunDir; uniform float uTime;
varying vec3 vDir;
#include "chunks/noise.glsl"
#include "chunks/sky.glsl"
void main(){
  vec3 d = normalize(vDir);
  vec3 c = skyColor(d, uSunDir);
  c += vec3(1.0,0.92,0.72) * pow(max(dot(d, uSunDir), 0.0), 900.0) * 10.0;   // sun disc
  c += vec3(1.0,0.85,0.6) * pow(max(dot(d, uSunDir), 0.0), 40.0) * 0.22;     // halo
  if (d.y > 0.02) {
    vec2 cp = d.xz / (d.y + 0.12) * 1.6 + vec2(uTime*0.004, 0.0);
    float cl = smoothstep(0.52, 0.78, fbm(cp)) * smoothstep(0.02, 0.18, d.y);
    c = mix(c, vec3(0.97,0.97,0.98), cl*0.55);
  }
  gl_FragColor = vec4(c, 1.0);
}
