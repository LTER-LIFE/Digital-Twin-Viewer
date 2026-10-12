// The drape texture holds the value normalised over the STORED range; the
// colour position is then computed in physical units so the user's chosen
// min/max (and log option) mean exactly what they say.
uniform vec4 uVarRange; uniform float uVarLog;
float varPosition(float raw){
  float v = uVarRange.x + raw * (uVarRange.y - uVarRange.x);
  float lo = uVarRange.z, hi = uVarRange.w;
  if (uVarLog > 0.5) {
    float l0 = max(lo, 1e-12);
    return log(max(v, l0 * 1e-6) / l0) / max(log(max(hi, l0 * 1.000001) / l0), 1e-6);
  }
  return (v - lo) / max(hi - lo, 1e-12);
}
