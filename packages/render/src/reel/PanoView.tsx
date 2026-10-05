import React, { useEffect, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender, useVideoConfig } from "remotion";
import { MAX_SHELL_POINTS, type CameraPose, type Spot } from "@reelwalk/core";

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// For every pixel of the 9:16 frame: cast a ray from the camera and find
// where it lands on the 360 image.
//
// When the photo knows the room around it (its "shell": the walls' outline,
// the floor and the ceiling), the ray is first followed to the surface it
// hits, and the photo is looked up in the direction of that point from where
// the photo was taken. From the photo's own position this gives the same
// picture as before. From anywhere else the walls, floor and ceiling stay
// put as the camera moves, which is what makes walking between two photos
// possible: both are projected onto their rooms and blended.
//
// World axes: x and y are the floor plan (y down the page), z is up.
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex0;
uniform sampler2D u_tex1;
uniform float u_previous;
uniform vec3 u_camera;
uniform float u_heading;
uniform float u_pitch;
uniform float u_tan_half_fov;
uniform float u_aspect;
uniform vec3 u_position0;
uniform vec3 u_position1;
uniform float u_heading0;
uniform float u_heading1;
uniform float u_ceiling0;
uniform float u_ceiling1;
uniform int u_count0;
uniform int u_count1;
uniform vec2 u_shell0[${MAX_SHELL_POINTS + 1}];
uniform vec2 u_shell1[${MAX_SHELL_POINTS + 1}];
const float PI = 3.14159265358979;
const float FAR = 1.0e9;

// Distance along the ray to the wall it leaves the room through. Walls are
// only seen from inside, so a camera outside the room looks through the near
// wall at the far one.
#define WALLS(NAME, SHELL, COUNT) \\
float NAME(vec2 origin, vec2 ray) { \\
  float nearest = FAR; \\
  for (int i = 0; i < ${MAX_SHELL_POINTS}; i++) { \\
    if (i >= COUNT) break; \\
    vec2 edge = SHELL[i + 1] - SHELL[i]; \\
    float facing = ray.x * edge.y - ray.y * edge.x; \\
    if (facing > 1.0e-9) { \\
      vec2 to = SHELL[i] - origin; \\
      float t = (to.x * edge.y - to.y * edge.x) / facing; \\
      float s = (to.x * ray.y - to.y * ray.x) / facing; \\
      if (t > 1.0e-6 && s >= 0.0 && s <= 1.0 && t < nearest) nearest = t; \\
    } \\
  } \\
  return nearest; \\
}
WALLS(walls0, u_shell0, u_count0)
WALLS(walls1, u_shell1, u_count1)

// Where a direction from the photo's position lands on the 360 image.
vec2 lookup(vec3 direction, float heading) {
  float lon = atan(direction.x, -direction.y) - heading;
  float lat = atan(direction.z, length(direction.xy));
  return vec2(fract(lon / (2.0 * PI) + 0.5), 0.5 - lat / PI);
}

// Direction from the photo's position to what the ray hits; reach is how far away that is.
vec3 towards(vec3 ray, float wall, float ceiling, vec3 position, out float reach) {
  float flat_ = ray.z < -1.0e-6 ? -u_camera.z / ray.z : ray.z > 1.0e-6 ? (ceiling - u_camera.z) / ray.z : FAR;
  reach = min(wall, flat_);
  // No room shape, or the ray misses it: treat the photo as infinitely far away.
  if (reach >= FAR) return ray;
  return u_camera + ray * reach - position;
}

// A surface right in front of the lens is a few blown-up pixels of its photo.
// Such a photo gives way there, so passing through a wall or a door never
// fills the frame with it.
float sharpness(float reach) {
  return smoothstep(0.12 * u_camera.z, 0.7 * u_camera.z, reach);
}

void main() {
  vec3 ray = normalize(vec3(v_uv.x * u_tan_half_fov * u_aspect, v_uv.y * u_tan_half_fov, -1.0));
  float cp = cos(u_pitch), sp = sin(u_pitch);
  ray = vec3(ray.x, ray.y * cp - ray.z * sp, ray.y * sp + ray.z * cp);
  float ch = cos(u_heading), sh = sin(u_heading);
  // Heading turns clockwise on the plan; straight ahead at heading 0 is up the page.
  vec3 world = vec3(ray.x * ch - ray.z * sh, ray.x * sh + ray.z * ch, ray.y);

  vec3 direction = world;
  float reach0 = FAR;
  if (u_count0 > 0) direction = towards(world, walls0(u_camera.xy, world.xy), u_ceiling0, u_position0, reach0);
  vec4 color = texture2D(u_tex0, lookup(direction, u_heading0));
  if (u_previous > 0.0) {
    direction = world;
    float reach1 = FAR;
    if (u_count1 > 0) direction = towards(world, walls1(u_camera.xy, world.xy), u_ceiling1, u_position1, reach1);
    float mine = (1.0 - u_previous) * sharpness(reach0);
    float theirs = u_previous * sharpness(reach1);
    float share = mine + theirs > 1.0e-4 ? theirs / (mine + theirs) : u_previous;
    color = mix(color, texture2D(u_tex1, lookup(direction, u_heading1)), share);
  }
  gl_FragColor = color;
}
`;

/** Largest texture edge used. Phones and the worker's software GL both handle this. */
const MAX_TEXTURE = 4096;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

type GlState = { gl: WebGLRenderingContext; uniforms: Record<string, WebGLUniformLocation | null> };

const UNIFORMS = [
  "u_tex0", "u_tex1", "u_previous", "u_camera", "u_heading", "u_pitch", "u_tan_half_fov", "u_aspect",
  "u_position0", "u_position1", "u_heading0", "u_heading1", "u_ceiling0", "u_ceiling1", "u_count0", "u_count1", "u_shell0", "u_shell1",
];

function setup(canvas: HTMLCanvasElement, images: HTMLImageElement[]): GlState {
  // preserveDrawingBuffer: the frame must still be on the canvas when it is captured.
  const gl = canvas.getContext("webgl", { preserveDrawingBuffer: true, antialias: false });
  if (!gl) throw new Error("WebGL is not available, so 360 photos cannot be shown.");

  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Shader failed to compile");
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Shader failed to link");
  gl.useProgram(program);

  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "a_position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  // Camera originals can be 8K or more; shrink to a size every GPU accepts.
  const limit = Math.min(MAX_TEXTURE, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
  images.forEach((image, unit) => {
    let source: TexImageSource = image;
    if (image.naturalWidth > limit) {
      const scaled = document.createElement("canvas");
      scaled.width = limit;
      scaled.height = Math.round((image.naturalHeight * limit) / image.naturalWidth);
      scaled.getContext("2d")!.drawImage(image, 0, 0, scaled.width, scaled.height);
      source = scaled;
    }
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    // CLAMP + LINEAR works for any image size in WebGL 1 (no mipmaps needed).
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  });

  const uniforms = Object.fromEntries(UNIFORMS.map((name) => [name, gl.getUniformLocation(program, name)]));
  gl.uniform1i(uniforms.u_tex0, 0);
  gl.uniform1i(uniforms.u_tex1, 1);
  return { gl, uniforms };
}

/**
 * A photo's place in the world: where it was taken, which way its centre
 * faces, and its room as a closed outline wound so that walls face inwards.
 */
function place(spot: Spot | null | undefined, planAspect: number) {
  const shell = spot?.shell;
  const eye = shell?.eye ?? 0;
  let points = (shell?.points ?? []).map(([x, y]) => [x * planAspect, y]);
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  if (area < 0) points = points.reverse();
  const outline = new Float32Array((MAX_SHELL_POINTS + 1) * 2);
  points.forEach(([x, y], index) => outline.set([x, y], index * 2));
  if (points.length > 0) outline.set(points[0], points.length * 2);
  return {
    position: [(spot?.x ?? 0) * planAspect, spot?.y ?? 0, eye] as const,
    heading: radians(spot?.heading ?? 0),
    ceiling: eye * (shell?.ceiling ?? 0),
    count: points.length,
    outline,
    eye,
  };
}

/**
 * A 360 photo seen through a moving camera. `camera` says where the camera
 * is on the plan and which way it faces. During a walk, `from` is the photo
 * the camera is leaving, and the picture is a blend of both.
 */
export const PanoView: React.FC<{
  src: string;
  spot?: Spot | null;
  from?: { src: string; spot: Spot } | null;
  camera: CameraPose;
  planAspect?: number;
  style?: React.CSSProperties;
}> = ({ src, spot, from, camera, planAspect = 1, style }) => {
  const { width, height } = useVideoConfig();
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef<GlState | null>(null);
  const [ready, setReady] = useState(false);
  // Frames must not be captured before the images are on the GPU.
  const [handle] = useState(() => delayRender("Loading 360 photo", { timeoutInMilliseconds: 60_000 }));
  const fromSrc = from?.src;

  useEffect(() => {
    let cancelled = false;
    const load = (url: string) =>
      new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.crossOrigin = "anonymous";
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error(`Could not load the 360 photo ${url.split("?")[0]}`));
        image.src = url;
      });
    Promise.all([src, ...(fromSrc ? [fromSrc] : [])].map(load))
      .then((images) => {
        if (cancelled || !canvas.current) return;
        state.current = setup(canvas.current, images);
        setReady(true);
      })
      .catch((error) => cancelRender(error));
    return () => {
      cancelled = true;
      state.current?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      state.current = null;
      setReady(false);
      continueRender(handle);
    };
  }, [src, fromSrc, handle]);

  useEffect(() => {
    const current = state.current;
    if (!ready || !current) return;
    const { gl, uniforms } = current;
    const here = place(spot, planAspect);
    const there = place(from?.spot, planAspect);
    const previous = fromSrc ? camera.previous : 0;
    // Camera height: each photo's own at its own end of the walk.
    const eye = here.eye + (there.eye - here.eye) * (there.eye > 0 ? previous : 0);
    gl.viewport(0, 0, width, height);
    gl.uniform1f(uniforms.u_previous, previous);
    gl.uniform3f(uniforms.u_camera, camera.x * planAspect, camera.y, eye);
    gl.uniform1f(uniforms.u_heading, radians(camera.heading));
    gl.uniform1f(uniforms.u_pitch, radians(camera.pitch));
    gl.uniform1f(uniforms.u_tan_half_fov, Math.tan(radians(camera.fov) / 2));
    gl.uniform1f(uniforms.u_aspect, width / height);
    gl.uniform3f(uniforms.u_position0, ...here.position);
    gl.uniform3f(uniforms.u_position1, ...there.position);
    gl.uniform1f(uniforms.u_heading0, here.heading);
    gl.uniform1f(uniforms.u_heading1, there.heading);
    gl.uniform1f(uniforms.u_ceiling0, here.ceiling);
    gl.uniform1f(uniforms.u_ceiling1, there.ceiling);
    gl.uniform1i(uniforms.u_count0, here.count);
    gl.uniform1i(uniforms.u_count1, there.count);
    gl.uniform2fv(uniforms.u_shell0, here.outline);
    gl.uniform2fv(uniforms.u_shell1, there.outline);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    continueRender(handle);
  }, [ready, spot, from, fromSrc, camera.x, camera.y, camera.heading, camera.pitch, camera.fov, camera.previous, planAspect, width, height, handle]);

  return <canvas ref={canvas} width={width} height={height} style={{ width: "100%", height: "100%", display: "block", ...style }} />;
};
