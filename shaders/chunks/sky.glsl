// Sky gradient with a warm glow toward the sun; also used for water reflections.
vec3 skyColor(vec3 d, vec3 sun){
  float h = clamp(d.y, -0.02, 1.0);
  vec3 c = mix(vec3(0.84,0.87,0.89), vec3(0.24,0.46,0.72), pow(max(h,0.0), 0.5));
  c += vec3(1.0,0.72,0.42) * pow(max(dot(d,sun),0.0), 6.0) * 0.32;
  return c;
}
