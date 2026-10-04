import React, { useEffect, useRef, useState } from "react";
import { cancelRender, continueRender, delayRender, useVideoConfig } from "remotion";
import type { PanoView as PanoSettings } from "@reelwalk/core";

const VERTEX_SHADER = `
attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  v_uv = a_position;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// For every pixel of the 9:16 frame: cast a ray from the camera, turn it by
// the camera's yaw and pitch, and look up where it lands on the 360 image.
const FRAGMENT_SHADER = `
precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_yaw;
uniform float u_pitch;
uniform float u_tan_half_fov;
uniform float u_aspect;
const float PI = 3.14159265358979;
void main() {
  vec3 ray = normalize(vec3(v_uv.x * u_tan_half_fov * u_aspect, v_uv.y * u_tan_half_fov, -1.0));
  float cp = cos(u_pitch), sp = sin(u_pitch);
  ray = vec3(ray.x, ray.y * cp - ray.z * sp, ray.y * sp + ray.z * cp);
  float cy = cos(u_yaw), sy = sin(u_yaw);
  ray = vec3(ray.x * cy - ray.z * sy, ray.y, ray.x * sy + ray.z * cy);
  float lon = atan(ray.x, -ray.z);
  float lat = asin(clamp(ray.y, -1.0, 1.0));
  gl_FragColor = texture2D(u_tex, vec2(lon / (2.0 * PI) + 0.5, 0.5 - lat / PI));
}
`;

/** Largest texture edge used. Phones and the worker's software GL both handle this. */
const MAX_TEXTURE = 4096;

const radians = (degrees: number) => (degrees * Math.PI) / 180;

type GlState = { gl: WebGLRenderingContext; uniforms: Record<string, WebGLUniformLocation | null> };

function setup(canvas: HTMLCanvasElement, image: HTMLImageElement): GlState {
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
  let source: TexImageSource = image;
  if (image.naturalWidth > limit) {
    const scaled = document.createElement("canvas");
    scaled.width = limit;
    scaled.height = Math.round((image.naturalHeight * limit) / image.naturalWidth);
    scaled.getContext("2d")!.drawImage(image, 0, 0, scaled.width, scaled.height);
    source = scaled;
  }
  gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  // CLAMP + LINEAR works for any image size in WebGL 1 (no mipmaps needed).
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

  const uniforms = Object.fromEntries(
    ["u_yaw", "u_pitch", "u_tan_half_fov", "u_aspect"].map((name) => [name, gl.getUniformLocation(program, name)]),
  );
  return { gl, uniforms };
}

/**
 * A 360 photo seen through a camera that turns from yawStart to yawEnd.
 * `progress` is 0 at the start of the clip and 1 at the end.
 */
export const PanoView: React.FC<{ src: string; pano: PanoSettings; progress: number; style?: React.CSSProperties }> = ({
  src,
  pano,
  progress,
  style,
}) => {
  const { width, height } = useVideoConfig();
  const canvas = useRef<HTMLCanvasElement>(null);
  const state = useRef<GlState | null>(null);
  const [ready, setReady] = useState(false);
  // Frames must not be captured before the image is on the GPU.
  const [handle] = useState(() => delayRender("Loading 360 photo", { timeoutInMilliseconds: 60_000 }));

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled || !canvas.current) return;
      try {
        state.current = setup(canvas.current, image);
        setReady(true);
      } catch (error) {
        cancelRender(error);
      }
    };
    image.onerror = () => cancelRender(new Error(`Could not load the 360 photo ${src.split("?")[0]}`));
    image.src = src;
    return () => {
      cancelled = true;
      state.current?.gl.getExtension("WEBGL_lose_context")?.loseContext();
      state.current = null;
      continueRender(handle);
    };
  }, [src, handle]);

  useEffect(() => {
    const current = state.current;
    if (!ready || !current) return;
    const { gl, uniforms } = current;
    const eased = progress * progress * (3 - 2 * progress); // ease in and out of the turn
    gl.viewport(0, 0, width, height);
    gl.uniform1f(uniforms.u_yaw, radians(pano.yawStart + (pano.yawEnd - pano.yawStart) * eased));
    gl.uniform1f(uniforms.u_pitch, radians(pano.pitch));
    gl.uniform1f(uniforms.u_tan_half_fov, Math.tan(radians(pano.fov) / 2));
    gl.uniform1f(uniforms.u_aspect, width / height);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    continueRender(handle);
  }, [ready, progress, pano.yawStart, pano.yawEnd, pano.pitch, pano.fov, width, height, handle]);

  return <canvas ref={canvas} width={width} height={height} style={{ width: "100%", height: "100%", display: "block", ...style }} />;
};
