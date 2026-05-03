/**
 * Liquid Orb WebGL renderer.
 *
 * Compiles the fragment shader and drives an animation loop at the monitor's
 * native refresh rate. Callers feed an intensity signal (0.0 – 1.0) via
 * setIntensity() — typically driven by agent activity (thinking, building).
 *
 *   const orb = new OrbRenderer(canvas)
 *   orb.start()
 *   orb.setIntensity(0.8)
 *   orb.stop()
 */

const VERTEX_SRC = /* glsl */`
  attribute vec2 a_position;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
  }
`

const FRAGMENT_SRC = /* glsl */`
  precision highp float;

  uniform float u_time;
  uniform float u_intensity;
  uniform vec2  u_resolution;

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
              / min(u_resolution.y, u_resolution.x);

    float idle_pulse = sin(u_time * 1.4) * 0.015;
    float intensity  = max(u_intensity, 0.01) + idle_pulse;

    float d = length(uv);
    float noise = sin(d * 10.0 - u_time * 2.0 + intensity * 5.0) * 0.1;
    d += noise;

    vec3 color = vec3(0.10, 0.07, 0.03) / max(d, 1e-4);
    color *= vec3(0.95, 0.78 + intensity * 0.15, 0.42 + intensity * 0.20);

    float mask = smoothstep(0.42, 0.36, d);
    color *= mask;

    gl_FragColor = vec4(color, mask);
  }
`

const QUAD = new Float32Array([-1, -1,  1, -1, -1,  1,  -1,  1,  1, -1,  1,  1])

const TARGET_FPS   = 120
const FRAME_BUDGET = 1000 / TARGET_FPS

export class OrbRenderer {
  private gl:        WebGLRenderingContext
  private program:   WebGLProgram
  private buf:       WebGLBuffer
  private uTime:     WebGLUniformLocation
  private uIntensity:WebGLUniformLocation
  private uRes:      WebGLUniformLocation
  private raf:       number = 0
  private startTime: number = performance.now()
  private lastFrame: number = 0
  private _intensity: number = 0
  private _posLoc:   number = -1

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false })
    if (!gl) throw new Error('WebGL not supported')
    this.gl = gl

    this.program    = this._compile(VERTEX_SRC, FRAGMENT_SRC)
    this.buf        = this._quad()
    this.uTime      = gl.getUniformLocation(this.program, 'u_time')!
    this.uIntensity = gl.getUniformLocation(this.program, 'u_intensity')!
    this.uRes       = gl.getUniformLocation(this.program, 'u_resolution')!

    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    this._posLoc = gl.getAttribLocation(this.program, 'a_position')
    gl.enableVertexAttribArray(this._posLoc)
  }

  setIntensity(value: number): void {
    this._intensity = Math.max(0, Math.min(1, value))
  }

  start(): void {
    this.startTime = performance.now()
    this._frame(performance.now())
  }

  stop(): void {
    cancelAnimationFrame(this.raf)
  }

  resize(w: number, h: number): void {
    this.canvas.width  = w
    this.canvas.height = h
    this.gl.viewport(0, 0, w, h)
  }

  private _frame = (now: number): void => {
    if (now - this.lastFrame < FRAME_BUDGET) {
      this.raf = requestAnimationFrame(this._frame)
      return
    }
    this.lastFrame = now

    const gl      = this.gl
    const elapsed = (now - this.startTime) / 1000

    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    gl.useProgram(this.program)
    gl.uniform1f(this.uTime, elapsed)
    gl.uniform1f(this.uIntensity, this._intensity)
    gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height)

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    gl.vertexAttribPointer(this._posLoc, 2, gl.FLOAT, false, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, 6)

    this.raf = requestAnimationFrame(this._frame)
  }

  private _compile(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl
    const vs = this._shader(gl.VERTEX_SHADER, vsSrc)
    const fs = this._shader(gl.FRAGMENT_SHADER, fsSrc)
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(prog)}`)
    }
    return prog
  }

  private _shader(type: number, src: string): WebGLShader {
    const gl     = this.gl
    const shader = gl.createShader(type)!
    gl.shaderSource(shader, src)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(`Shader compile error: ${gl.getShaderInfoLog(shader)}`)
    }
    return shader
  }

  private _quad(): WebGLBuffer {
    const gl  = this.gl
    const buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, QUAD, gl.STATIC_DRAW)
    return buf
  }
}
