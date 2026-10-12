// Sediment strata: warped bands of silt, sand and clay with fine laminations.
uniform vec3 uSunDir; uniform float uBaseM;
varying float vHM, vAlong, vTopM; varying vec3 vN, vWorld;
#include "chunks/noise.glsl"
#include "chunks/fog.glsl"
void main(){
  // stratified sediment: warped horizontal bands
  float warp = fbm(vec2(vAlong*0.045, vHM*0.16)) * 5.0;
  float y = vHM + warp;
  float b1 = fbm(vec2(4.7, y*0.35));
  float b2 = fbm(vec2(19.3, y*1.3));
  vec3 silt = vec3(0.36,0.30,0.24);
  vec3 sand = vec3(0.62,0.53,0.38);
  vec3 clay = vec3(0.44,0.43,0.40);
  vec3 dark = vec3(0.22,0.18,0.14);
  vec3 c = mix(silt, sand, smoothstep(0.35,0.65,b1));
  c = mix(c, clay, smoothstep(0.55,0.8,b2)*0.6);
  c = mix(c, dark, smoothstep(0.7,0.95,fbm(vec2(2.2, y*2.6)))*0.5);
  // fine laminations
  c *= 0.92 + 0.14*sin(y*7.0 + fbm(vec2(vAlong*0.2, y))*4.0);
  // darker with depth, lighter topsoil cap
  c *= mix(0.55, 1.05, smoothstep(uBaseM, 5.0, vHM));
  c = mix(c, vec3(0.55,0.48,0.34), smoothstep(1.2, 0.0, vTopM - vHM)*0.55);
  float dif = max(dot(normalize(vN), uSunDir), 0.0);
  vec3 col = c * (vec3(0.38,0.36,0.34) + vec3(1.0,0.93,0.8)*dif*0.9);
  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, 1.0);
}
