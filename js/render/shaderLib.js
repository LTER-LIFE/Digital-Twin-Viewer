// GLSL sources live in ../../shaders as plain files, one per stage:
// `<name>.vert.glsl` and `<name>.frag.glsl`, plus shared snippets under
// `chunks/`. All of them are fetched once at boot (top-level await), so by the
// time any render module runs, program(name) can hand back finished source.
//
// A file pulls in a chunk with `#include "chunks/noise.glsl"`, resolved here
// before three.js ever sees the text. The quoted form is deliberate: three.js
// resolves `#include <name>` against its own ShaderChunk library and throws on
// any name it does not know.

const ROOT = new URL('../../shaders/', import.meta.url);

/** Every program the scene builds. Adding a material means adding its pair of
 *  files and its name here. */
const PROGRAMS = ['terrain', 'water', 'flow-trails', 'strata', 'water-skirt', 'sky', 'obs-markers'];

const INCLUDE = /^[ \t]*#include\s+"([^"]+)"[ \t]*$/gm;

const files = new Map();          // path -> Promise<string>, so a chunk is fetched once

function fetchText(path) {
  if (!files.has(path)) {
    files.set(path, fetch(new URL(path, ROOT)).then((res) => {
      if (!res.ok) throw new Error(`shaders/${path}: ${res.status}`);
      return res.text();
    }));
  }
  return files.get(path);
}

/** Source of one file with every `#include "..."` expanded, recursively. */
async function resolve(path, stack = []) {
  if (stack.includes(path)) throw new Error(`shader include cycle: ${[...stack, path].join(' -> ')}`);
  const text = await fetchText(path);
  const names = [...text.matchAll(INCLUDE)].map((m) => m[1]);
  const parts = await Promise.all(names.map((n) => resolve(n, [...stack, path])));
  const byName = new Map(names.map((n, i) => [n, parts[i]]));
  return text.replace(INCLUDE, (_, n) => byName.get(n));
}

const sources = new Map(await Promise.all(PROGRAMS.map(async (name) => {
  const [vertexShader, fragmentShader] = await Promise.all([
    resolve(`${name}.vert.glsl`), resolve(`${name}.frag.glsl`),
  ]);
  return [name, { vertexShader, fragmentShader }];
})));

/** `{ vertexShader, fragmentShader }` for a ShaderMaterial, ready to spread. */
export function program(name) {
  const p = sources.get(name);
  if (!p) throw new Error(`unknown shader program "${name}"`);
  return p;
}
