// Distance fog toward uFogColor between uFogRange.x and uFogRange.y (world units).
uniform vec3 uFogColor; uniform vec2 uFogRange;
vec3 applyFog(vec3 c, vec3 world){
  float d = distance(world, cameraPosition);
  float f = smoothstep(uFogRange.x, uFogRange.y, d);
  return mix(c, uFogColor, f*0.88);
}
