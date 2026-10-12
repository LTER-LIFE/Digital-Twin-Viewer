// Translucent water side walls, darkening with depth below the surface.
uniform vec3 uSunDir; uniform float uAlphaMul, uMode, uVarOn;
varying float vYM, vLevel, vBed; varying vec3 vN, vWorld;
#include "chunks/noise.glsl"
#include "chunks/fog.glsl"
void main(){
  float col_h = vLevel - vBed;
  if (col_h < 0.01) discard;
  float below = vLevel - vYM;
  vec3 c = mix(vec3(0.30,0.55,0.56), vec3(0.04,0.16,0.24), 1.0 - exp(-below*0.35));
  float dif = max(dot(normalize(vN), uSunDir), 0.0);
  c *= 0.55 + 0.5*dif;
  float alpha = mix(0.42, 0.8, 1.0 - exp(-below*0.4)) * uAlphaMul;
  if (uMode > 0.5) alpha *= 0.5;
  if (uVarOn > 0.5) alpha *= 0.3;
  c = applyFog(c, vWorld);
  gl_FragColor = vec4(c, alpha);
}
