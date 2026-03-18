# Analog Video Feedback Loop Shader

Emulates the behaviour of analog video mixers like the Edirol V4/V8 with internal signal generation and feedback processing.

Designed for Raspberry Pi deployment — optimised for OpenGL ES 2.0/3.0.

## Overview

This shader simulates the classic analog video feedback effect where the output is fed back into the input with transformations applied each frame. Unlike camera-based feedback, this implementation uses internal generators to seed the feedback loop, making it fully self-contained.

## Signal Flow

```
Internal Generator → Effects Chain → Feedback Loop → Output
                          ↑                             ↓
                          ←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←
```

## Files

- `feedback.frag` — Main fragment shader
- `passthrough.vert` — Simple vertex shader for fullscreen quad
- `README.md` — This documentation

## Host Application Requirements

The host application (Processing, openFrameworks, or custom) must:

1. **Create two framebuffers** (ping-pong buffers) for feedback
2. **Swap buffers each frame** — current output becomes next frame's input
3. **Bind the previous frame** as `u_feedback` texture
4. **Update uniforms** — pass time, resolution, and MIDI-mapped parameters
5. **Render a fullscreen quad** using these shaders

## Uniform Reference

### Core Uniforms

| Uniform | Type | Description |
|---------|------|-------------|
| `u_feedback` | sampler2D | Previous frame texture |
| `u_time` | float | Time in seconds |
| `u_resolution` | vec2 | Output resolution |

---

## MIDI Mapping Guide

All parameters are designed for direct MIDI CC mapping. Suggested CC assignments below.

### Generator Parameters (CC 1–9)

| CC | Uniform | Range | Default | Description |
|----|---------|-------|---------|-------------|
| 1 | `u_gen_type` | 0–6 | 0 | Generator type (see below) |
| 2 | `u_gen_frequency` | 0.1–20.0 | 1.0 | Animation/oscillator speed (for type 3: shape selection) |
| 3 | `u_gen_size` | 0.0–1.0 | 0.3 | Size/radius/scale |
| 4 | `u_gen_pos_x` | -1.0–1.0 | 0.0 | X position offset |
| 5 | `u_gen_pos_y` | -1.0–1.0 | 0.0 | Y position offset |
| 6 | `u_gen_softness` | 0.0–1.0 | 0.5 | Edge softness |
| 7 | `u_gen_hue` | 0.0–1.0 | 0.0 | Generator colour (hue) |
| 8 | `u_gen_intensity` | 0.0–1.0 | 0.5 | How much generator feeds in |
| Note | `u_gen_trigger` | 0.0–1.0 | 0.0 | Flash trigger (use Note On) |

**Generator Types:**
- 0 = Off
- 1 = Voronoi / Cellular (tile-based distance field with animated cell centres)
- 2 = Domain-Warped Noise (noise feeding noise for fluid swirls)
- 3 = Outlined Shapes (hollow circle, rectangle, and diamond outlines)
- 4 = Diagonal Stripes / Grid (rotating stripe patterns with crosshatch)
- 5 = Reaction-Diffusion Seed (Gray-Scott-inspired organic patterns)
- 6 = Moiré Pattern (dual-frequency interference)

### Feedback Parameters (CC 10–11, 42–44)

| CC | Uniform | Range | Default | Description |
|----|---------|-------|---------|-------------|
| 10 | `u_fb_amount` | 0.0–1.0 | 0.9 | Feedback mix amount |
| 11 | `u_fb_decay` | 0.0–1.0 | 0.98 | Trail decay rate |
| 42 | `u_fb_tap2_amount` | 0.0–1.0 | 0.0 | Second feedback tap mix amount |
| 43 | `u_fb_tap2_offset` | -0.1–0.1 | 0.0 | Second tap rotation offset (radians) |
| 44 | `u_fb_delay_amount` | 0.0–1.0 | 0.0 | Long-delay buffer mix amount |

### Transform Parameters (CC 12–16, 41)

| CC | Uniform | Range | Default | Description |
|----|---------|-------|---------|-------------|
| 12 | `u_tf_scale` | 0.9–1.1 | 1.01 | Zoom (>1 = tunnel in) |
| 13 | `u_tf_rotation` | -0.1–0.1 | 0.01 | Rotation per frame (radians) |
| 14 | `u_tf_translate_x` | -0.1–0.1 | 0.0 | X drift |
| 15 | `u_tf_translate_y` | -0.1–0.1 | 0.0 | Y drift |
| 16 | `u_tf_mirror` | 0–4 | 0 | Mirror mode (see below) |
| 41 | `u_tf_displace` | 0.0–0.1 | 0.0 | UV displacement from luminance |

**Mirror Modes:**
- 0 = Off
- 1 = Horizontal mirror
- 2 = Vertical mirror
- 3 = Quad (both axes)
- 4 = Kaleidoscope (6-fold)

### Edge Detection Parameters (CC 17–21)

| CC | Uniform | Range | Default | Description |
|----|---------|-------|---------|-------------|
| 17 | `u_edge_type` | 0–4 | 0 | Edge detection algorithm |
| 18 | `u_edge_mix` | 0.0–1.0 | 0.5 | Original → edges mix |
| 19 | `u_edge_threshold` | 0.0–1.0 | 0.1 | Edge sensitivity |
| 20 | `u_edge_colour_mode` | 0–2 | 0 | Edge colouring mode |
| 21 | `u_edge_pre_fb` | 0–1 | 0 | Apply before feedback? |

**Edge Detection Types:**
- 0 = Off
- 1 = Roberts Cross (2 samples — fastest)
- 2 = Gradient (4 samples — good balance)
- 3 = Sobel (9 samples — best quality)
- 4 = Temporal (1 sample — motion-reactive)

**Edge Colour Modes:**
- 0 = White edges
- 1 = Coloured edges (original colour)
- 2 = Tinted (edge overlay)

### Effects Parameters (CC 22–28)

| CC | Uniform | Range | Default | Description |
|----|---------|-------|---------|-------------|
| 22 | `u_fx_posterize` | 0, 2–32 | 0 | Posterize levels (0=off) |
| 23 | `u_fx_posterize_smooth` | 0.0–1.0 | 0.0 | Posterize smoothing |
| 24 | `u_fx_solarize` | 0.0–1.0 | 0.0 | Solarize threshold (0=off) |
| 25 | `u_fx_solarize_soft` | 0.0–1.0 | 0.5 | Solarize softness |
| 26 | `u_fx_solarize_mode` | 0–2 | 0 | Solarize algorithm |
| 27 | `u_fx_threshold` | 0.0–1.0 | 0.0 | Binary threshold (0=off) |
| 28 | `u_fx_pixelate` | 1–64 | 1 | Pixel size (1=off) |
| 29 | `u_fx_pre_fb` | 0–1 | 0 | Apply before feedback? |

**Solarize Modes:**
- 0 = Classic (invert above threshold)
- 1 = Symmetric (V-shape curve)
- 2 = Multi-fold

### Colour Parameters (CC 30–35)

| CC | Uniform | Range | Default | Description |
|----|---------|-------|---------|-------------|
| 30 | `u_col_hue_shift` | 0.0–1.0 | 0.0 | Hue rotation |
| 31 | `u_col_saturation` | 0.0–2.0 | 1.0 | Saturation multiplier |
| 32 | `u_col_brightness` | -0.5–0.5 | 0.0 | Brightness offset |
| 33 | `u_col_contrast` | 0.5–2.0 | 1.0 | Contrast multiplier |
| 34 | `u_col_rgb_sep` | 0.0–0.05 | 0.0 | RGB separation |
| 35 | `u_col_invert` | 0.0–1.0 | 0.0 | Inversion amount |

### Blend Parameters (CC 36)

| CC | Uniform | Range | Default | Description |
|----|---------|-------|---------|-------------|
| 36 | `u_blend_mode` | 0–5 | 0 | Blend mode |

**Blend Modes:**
- 0 = Mix (linear)
- 1 = Add
- 2 = Multiply
- 3 = Screen
- 4 = Difference
- 5 = Overlay

### Post-Processing Parameters (CC 37–40)

| CC | Uniform | Range | Default | Description |
|----|---------|-------|---------|-------------|
| 37 | `u_post_blur` | 0.0–1.0 | 0.0 | Blur amount |
| 38 | `u_post_noise` | 0.0–0.1 | 0.0 | Noise amount |
| 39 | `u_post_soft_clip` | 0.0–1.0 | 0.0 | Soft clipping |
| 40 | `u_post_sharpen` | 0.0–1.0 | 0.0 | Sharpening |

---

## Performance Notes

### Edge Detection Performance (per pixel)

| Type | Texture Samples | Relative Cost |
|------|-----------------|---------------|
| Off | 0 | — |
| Roberts | 3 | Fastest |
| Gradient | 4 | Fast |
| Sobel | 9 | Moderate |
| Temporal | 1 | Minimal |

**Recommendation for Raspberry Pi:**
- Use Roberts or Gradient for real-time performance
- Sobel is fine on Pi 4, may struggle on Pi 3
- Temporal is essentially free and creates unique motion-reactive edges

### Pre-Feedback vs Post-Feedback Effects

When `u_edge_pre_fb` or `u_fx_pre_fb` is set to 1:
- Effects are applied to the feedback before blending
- Creates compounding/accumulating effect over time
- Can be more expensive for edge detection (samples feedback texture multiple times)

When set to 0:
- Effects are applied to final output only
- Cleaner, more predictable results
- Generally faster

### New Features Performance Cost

**UV Displacement** (CC 41):
- Adds up to 3 texture samples (for RGB separation re-sample)
- When set to 0, the displaced UV equals the original UV (branchless no-op)
- Moderate cost, creates fluid warping effects

**Second Feedback Tap** (CC 42–43):
- Adds 1 texture sample per pixel
- Always samples even when amount is 0 (blended away via mix)
- Minimal cost for rich multi-tap effects

**Long-Delay Buffer** (CC 44):
- Adds 1 texture sample per pixel
- Host updates delay buffer every 8 frames (minimal CPU overhead)
- Minimal cost, creates echo/ghost trail effects

**Reaction-Diffusion Generator** (Type 5):
- Adds 4 cardinal neighbour samples when active
- Most expensive new generator (reads from feedback texture)
- Produces unique organic patterns that evolve over time
- Use sparingly on Pi 3, fine on Pi 4

### Optimisation Tips

1. **Start with transforms only** — feedback + scale + rotation creates most of the classic effect
2. **Add one effect at a time** — find the performance ceiling
3. **Pixelate reduces work** — lower resolution = fewer calculations
4. **Temporal edges are free** — they reuse the feedback sample
5. **Avoid Sobel in pre-feedback mode** — 9 extra samples per pixel adds up
6. **Reaction-diffusion is expensive** — use types 1–4 or 6 for better Pi 3 performance
7. **Multiple taps are cheap** — tap2 and delay each add only 1 sample
8. **Displacement cost scales with RGB separation** — when both are active, cost multiplies

---

## Example Starting Points

### Classic Tunnel

```
u_gen_type = 1 (voronoi)
u_gen_intensity = 0.3
u_fb_amount = 0.95
u_fb_decay = 0.98
u_tf_scale = 1.02
u_tf_rotation = 0.02
```

### Psychedelic Swirl (Domain-Warped Noise)

```
u_gen_type = 2 (domain-warped noise)
u_gen_size = 0.4
u_gen_softness = 0.6
u_gen_intensity = 0.2
u_fb_amount = 0.9
u_col_hue_shift = 0.01 (slowly rotating)
u_tf_rotation = 0.03
u_fx_solarize = 0.5
```

### Glitch Edges with Multi-Tap

```
u_gen_type = 6 (moire)
u_gen_intensity = 0.4
u_edge_type = 2 (gradient)
u_edge_mix = 0.7
u_edge_pre_fb = 1
u_col_rgb_sep = 0.02
u_tf_displace = 0.02
u_fb_tap2_amount = 0.3
u_fb_tap2_offset = 0.015
```

### Minimal Decay

```
u_gen_type = 4 (diagonal stripes)
u_gen_intensity = 0.5
u_fb_amount = 0.8
u_fb_decay = 0.7
u_fx_posterize = 8
```

### Outlined Shapes

```
u_gen_type = 3 (outlined shapes)
u_gen_frequency = 0.5-5.0 (cycles through circle, rectangle, diamond)
u_gen_size = 0.4
u_gen_softness = 0.3 (outline thickness)
u_gen_intensity = 0.6
u_fb_amount = 0.95
u_fb_decay = 0.98
u_tf_scale = 1.01
u_tf_rotation = 0.015
```

### Organic Growth (Reaction-Diffusion)

```
u_gen_type = 5 (reaction-diffusion)
u_gen_size = 0.3 (feed rate)
u_gen_frequency = 0.5 (kill rate)
u_gen_softness = 0.4 (diffusion)
u_gen_intensity = 0.8
u_fb_amount = 0.95
u_fb_decay = 0.99
u_tf_scale = 1.005
```

### Ghost Trails (Delay Buffer)

```
u_gen_type = 1 (voronoi)
u_gen_intensity = 0.4
u_fb_amount = 0.85
u_fb_decay = 0.9
u_fb_delay_amount = 0.5
u_col_hue_shift = 0.005
```

---

## Integration Examples

### Processing (Java)

```java
PShader feedback;
PGraphics[] buffers = new PGraphics[2];
int currentBuffer = 0;

void setup() {
  size(1280, 720, P2D);
  feedback = loadShader("feedback.frag", "passthrough.vert");
  buffers[0] = createGraphics(width, height, P2D);
  buffers[1] = createGraphics(width, height, P2D);
}

void draw() {
  int prev = currentBuffer;
  currentBuffer = 1 - currentBuffer;
  
  feedback.set("u_feedback", buffers[prev]);
  feedback.set("u_time", millis() / 1000.0);
  feedback.set("u_resolution", (float)width, (float)height);
  // Set all other uniforms from MIDI...
  
  buffers[currentBuffer].beginDraw();
  buffers[currentBuffer].shader(feedback);
  buffers[currentBuffer].rect(0, 0, width, height);
  buffers[currentBuffer].endDraw();
  
  image(buffers[currentBuffer], 0, 0);
}
```

### openFrameworks (C++)

```cpp
ofFbo fbos[2];
int currentFbo = 0;
ofShader shader;

void setup() {
  fbos[0].allocate(1280, 720, GL_RGBA);
  fbos[1].allocate(1280, 720, GL_RGBA);
  shader.load("passthrough.vert", "feedback.frag");
}

void draw() {
  int prev = currentFbo;
  currentFbo = 1 - currentFbo;
  
  fbos[currentFbo].begin();
  shader.begin();
  shader.setUniformTexture("u_feedback", fbos[prev].getTexture(), 0);
  shader.setUniform1f("u_time", ofGetElapsedTimef());
  shader.setUniform2f("u_resolution", 1280, 720);
  // Set all other uniforms from MIDI...
  ofDrawRectangle(0, 0, 1280, 720);
  shader.end();
  fbos[currentFbo].end();
  
  fbos[currentFbo].draw(0, 0);
}
```

---

## License

Part of research project: "Enhancing Audiovisual Performance Through Accessible Generative Software and Hardware"

Queensland Conservatorium Griffith University

---

## Changelog

- v1.0 — Initial release with full parameter set
- Internal generators, feedback, transforms, edge detection (4 modes), posterize, solarize, threshold, colour processing, blend modes, post-processing
