/* global URL, console */
// Next 16's static export writes route segment data as nested folders
// (map/__next.map/__PAGE__.txt) while the client prefetches flat names
// (map/__next.map.__PAGE__.txt). Static hosts can't rewrite, so copy each
// nested file to its flat name; otherwise every prefetch 404s and links fall
// back to full page loads.
import { copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../out/", import.meta.url));
let copied = 0;

function flatten(dir, prefix, parent) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const flat = `${prefix}.${name}`;
    if (statSync(path).isDirectory()) flatten(path, flat, parent);
    else {
      copyFileSync(path, join(parent, flat));
      copied++;
    }
  }
}

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (!statSync(path).isDirectory()) continue;
    if (name.startsWith("__next.")) flatten(path, name, dir);
    else walk(path);
  }
}

walk(out);
console.log(`flatten-segments: ${copied} files`);
