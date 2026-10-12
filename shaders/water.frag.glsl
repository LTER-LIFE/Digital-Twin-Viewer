// Water sheet: depth colour, procedural waves, sky reflection, sun glint and
// shoreline foam. Dry cells (depth below a few mm) are discarded.
uniform sampler2D uTerrainTex;
uniform float uHS, uTime, uMode, uAlphaMul, uVarOn;
uniform vec3 uSunDir;
varying vec2 vUvT; varying vec3 vWorld; varying float vLevel;
#include "chunks/noise.glsl"
#include "chunks/sky.glsl"
#include "chunks/fog.glsl"
vec2 waveG(vec2 p, vec2 dir, float f, float sp, float t){
  return dir * cos(dot(p, dir)*f + t*sp) * f;
}
void main(){
  float h = texture2D(uTerrainTex, vUvT).r;
  float depth = vLevel - h;
  if (depth < 0.004) discard;
  float shore = smoothstep(0.0, 0.16, depth);

  vec2 p = vWorld.xz;
  float t = uTime;
  vec2 g = waveG(p, normalize(vec2(1.0,0.35)), 1.1, 0.9, t)*0.030
         + waveG(p, normalize(vec2(-0.5,1.0)), 2.7, 1.4, t)*0.016
         + waveG(p, normalize(vec2(0.8,-0.6)), 7.5, 2.2, t)*0.007
         + waveG(p, normalize(vec2(-1.0,-0.2)), 16.0, 3.1, t)*0.0035;
  vec3 nrm = normalize(vec3(-g.x, 1.0, -g.y));

  vec3 V = normalize(cameraPosition - vWorld);
  float F = 0.02 + 0.98*pow(1.0 - max(dot(nrm, V), 0.0), 5.0);

  vec3 shallowC = (uMode < 0.5) ? vec3(0.36,0.62,0.60) : vec3(0.25,0.55,0.75);
  vec3 deepC    = (uMode < 0.5) ? vec3(0.05,0.19,0.28) : vec3(0.05,0.15,0.30);
  vec3 base = mix(shallowC, deepC, 1.0 - exp(-depth*0.32));

  vec3 refl = skyColor(reflect(-V, nrm), uSunDir);
  float spec = pow(max(dot(nrm, normalize(uSunDir + V)), 0.0), 220.0) * 2.4;

  // shoreline foam
  float foamBand = smoothstep(0.34, 0.02, depth);
  float fn = fbm(p*2.1 + vec2(t*0.35, -t*0.28)) + fbm(p*5.3 - vec2(t*0.5, 0.0))*0.5;
  float foam = foamBand * smoothstep(0.75, 1.05, fn + foamBand*0.55);

  vec3 col = mix(base, refl, F*0.7);
  col += vec3(1.0,0.95,0.85) * spec;
  col = mix(col, vec3(0.92,0.95,0.96), foam);

  float alpha = mix(0.30, 0.94, 1.0 - exp(-depth*0.55)) * uAlphaMul;
  if (uMode > 0.5) alpha *= 0.42;
  alpha = max(alpha, foam*0.85);
  alpha *= shore;
  if (uVarOn > 0.5) alpha *= 0.22;   // let the colored bed field show through

  col = applyFog(col, vWorld);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.96));
}
