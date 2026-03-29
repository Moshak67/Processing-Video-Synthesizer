// ============================================================================
// ANALOG VIDEO FEEDBACK LOOP SHADER
// ============================================================================
// Emulates the behaviour of analog video mixers like Edirol V4/V8
// with internal signal generation and feedback processing.
//
// Designed for Raspberry Pi 3 deployment - optimised for OpenGL ES 2.0
// All branching replaced with branchless step()/mix() patterns
// All parameters exposed as uniforms for MIDI mapping
//
// Author: Mo / Queensland Conservatorium Griffith University
// Research: Enhancing Audiovisual Performance Through Accessible
//           Generative Software and Hardware
// ============================================================================

#ifdef GL_ES
precision mediump float;
#endif

// ============================================================================
// UNIFORMS - All MIDI-mappable parameters
// ============================================================================

// Core uniforms
uniform sampler2D u_feedback;      // Previous frame (ping-pong buffer)
uniform float u_time;              // Time in seconds
uniform vec2 u_resolution;         // Output resolution

// -----------------------------------------------------------------------------
// GENERATOR PARAMETERS (CC 1-9)
// All mode/type uniforms are float for branchless step() on VideoCore IV
// -----------------------------------------------------------------------------
uniform float u_gen_type;           // 0=off, 1=voronoi, 2=domain-warped, 3=outlined-shapes, 4=stripes, 5=reaction-diffusion, 6=moire
uniform float u_gen_frequency;     // Oscillator/animation frequency [0.1 - 20.0]
uniform float u_gen_size;          // Size/radius/scale [0.0 - 1.0]
uniform float u_gen_pos_x;         // X position [-1.0 - 1.0]
uniform float u_gen_pos_y;         // Y position [-1.0 - 1.0]
uniform float u_gen_softness;      // Edge softness [0.0 - 1.0]
uniform float u_gen_hue;           // Generator colour hue [0.0 - 1.0]
uniform float u_gen_intensity;     // How much generator feeds in [0.0 - 1.0]
uniform float u_gen_trigger;       // Momentary flash trigger [0.0 - 1.0]

// -----------------------------------------------------------------------------
// FEEDBACK PARAMETERS (CC 10-11, 42-44)
// -----------------------------------------------------------------------------
uniform float u_fb_amount;         // Feedback mix amount [0.0 - 1.0]
uniform float u_fb_decay;          // Trail decay rate [0.0 - 1.0]
uniform float u_fb_tap2_amount;    // Second feedback tap mix [0.0 - 1.0] (CC 42)
uniform float u_fb_tap2_offset;    // Second tap rotation offset [-0.1 - 0.1] (CC 43)
uniform sampler2D u_delay_feedback; // Long-delay feedback buffer
uniform float u_fb_delay_amount;   // Delay buffer mix [0.0 - 1.0] (CC 44)
uniform sampler2D u_gen_image;     // Image source for generator type 7

// -----------------------------------------------------------------------------
// TRANSFORM PARAMETERS (CC 12-16)
// -----------------------------------------------------------------------------
uniform float u_tf_scale;          // Zoom scale [0.9 - 1.1]
uniform float u_tf_rotation;       // Rotation per frame (radians) [-0.1 - 0.1]
uniform float u_tf_translate_x;    // X drift [-0.1 - 0.1]
uniform float u_tf_translate_y;    // Y drift [-0.1 - 0.1]
uniform float u_tf_mirror;         // 0=off, 1=horiz, 2=vert, 3=quad, 4=kaleidoscope
uniform float u_tf_displace;       // UV displacement from luminance [0.0 - 0.1] (CC 41)

// -----------------------------------------------------------------------------
// EDGE DETECTION PARAMETERS (CC 17-21)
// NOTE: Edge detection keeps if/else branching intentionally.
// Sobel requires 8 extra texture samples - computing all edge types
// branchlessly every frame would be far more expensive than the branch cost.
// -----------------------------------------------------------------------------
uniform float u_edge_type;         // 0=off, 1=roberts, 2=gradient, 3=sobel, 4=temporal
uniform float u_edge_mix;          // Original to edge mix [0.0 - 1.0]
uniform float u_edge_threshold;    // Edge sensitivity [0.0 - 1.0]
uniform float u_edge_colour_mode;  // 0=white, 1=coloured, 2=tinted
uniform float u_edge_pre_fb;       // Apply before feedback? 0=no, 1=yes

// -----------------------------------------------------------------------------
// EFFECTS PARAMETERS (CC 22-28)
// -----------------------------------------------------------------------------
uniform float u_fx_posterize;      // Posterize levels [0=off, 2-32]
uniform float u_fx_posterize_smooth; // Posterize smoothing [0.0 - 1.0]
uniform float u_fx_solarize;       // Solarize threshold [0=off, 0.01-1.0]
uniform float u_fx_solarize_soft;  // Solarize softness [0.0 - 1.0]
uniform float u_fx_solarize_mode;  // 0=classic, 1=symmetric, 2=multi
uniform float u_fx_threshold;      // Binary threshold [0=off, 0.01-1.0]
uniform float u_fx_pixelate;       // Pixel size [1=off, 2-64]
uniform float u_fx_pre_fb;         // Apply effects before feedback? 0=no, 1=yes

// -----------------------------------------------------------------------------
// COLOUR PARAMETERS (CC 29-34)
// -----------------------------------------------------------------------------
uniform float u_col_hue_shift;     // Hue rotation [0.0 - 1.0]
uniform float u_col_saturation;    // Saturation multiplier [0.0 - 2.0]
uniform float u_col_brightness;    // Brightness offset [-0.5 - 0.5]
uniform float u_col_contrast;      // Contrast multiplier [0.5 - 2.0]
uniform float u_col_rgb_sep;       // RGB channel separation [0.0 - 0.05]
uniform float u_col_invert;        // Inversion amount [0.0 - 1.0]

// -----------------------------------------------------------------------------
// BLEND PARAMETERS (CC 35)
// -----------------------------------------------------------------------------
uniform float u_blend_mode;        // 0=mix, 1=add, 2=multiply, 3=screen, 4=difference, 5=overlay

// -----------------------------------------------------------------------------
// POST-PROCESSING PARAMETERS (CC 36-39)
// -----------------------------------------------------------------------------
uniform float u_post_blur;         // Blur amount [0.0 - 1.0]
uniform float u_post_noise;        // Noise amount [0.0 - 0.1]
uniform float u_post_soft_clip;    // Soft clipping [0.0 - 1.0]
uniform float u_post_sharpen;      // Sharpening [0.0 - 1.0]


// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

// Pixel size for sampling offsets
vec2 px;

// Luminance calculation (ITU-R BT.709)
float luminance(vec3 col) {
    return dot(col, vec3(0.2126, 0.7152, 0.0722));
}

// HSV to RGB conversion
vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// RGB to HSV conversion
vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}

// Simple hash for noise
float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

// Value noise
float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // smoothstep

    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));

    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// Fractal noise (2 octaves for performance)
float fbm(vec2 p) {
    float v = 0.0;
    v += 0.5 * valueNoise(p); p *= 2.0;
    v += 0.25 * valueNoise(p);
    return v * 1.33; // normalize
}

// tanh approximation - tanh() is not available in GLSL ES 1.00 (OpenGL ES 2.0)
// Uses rational polynomial: tanh(x) ~ x*(27+x^2)/(27+9*x^2)
vec3 tanhApprox(vec3 x) {
    vec3 x2 = x * x;
    return x * (27.0 + x2) / (27.0 + 9.0 * x2);
}


// ============================================================================
// TRANSFORM FUNCTIONS (branchless)
// ============================================================================

vec2 applyMirror(vec2 uv) {
    if (u_tf_mirror < 0.5) return uv;  // mode 0: off — skip all trig

    if (u_tf_mirror > 3.5) {
        // mode 4: kaleidoscope — only trig when actually used
        vec2 centered = uv - 0.5;
        float angle = atan(centered.y, centered.x);
        float segments = 6.0;
        angle = mod(angle, 6.28318 / segments);
        angle = abs(angle - 3.14159 / segments);
        float radius = length(centered);
        return vec2(cos(angle), sin(angle)) * radius + 0.5;
    }

    // mode 1: H,  mode 2: V,  mode 3: quad (H+V)
    if (u_tf_mirror < 1.5 || u_tf_mirror > 2.5)   // modes 1 and 3
        uv.x = abs(uv.x - 0.5) + 0.5;
    if (u_tf_mirror > 1.5)                         // modes 2 and 3
        uv.y = abs(uv.y - 0.5) + 0.5;

    return uv;
}

vec2 applyTransforms(vec2 uv) {
    // Centre for rotation/scale
    vec2 centered = uv - 0.5;

    // Scale (zoom)
    centered /= u_tf_scale;

    // Rotation
    float s = sin(u_tf_rotation);
    float c = cos(u_tf_rotation);
    centered = vec2(
        centered.x * c - centered.y * s,
        centered.x * s + centered.y * c
    );

    // Translation
    centered -= vec2(u_tf_translate_x, u_tf_translate_y);

    // Back to UV space
    uv = centered + 0.5;

    // Mirror modes (branchless)
    uv = applyMirror(uv);

    return uv;
}


// ============================================================================
// GENERATOR FUNCTIONS (branchless)
// ============================================================================

vec3 generateSource(vec2 uv, vec2 fb_uv) {
    vec2 centered = uv - 0.5 - vec2(u_gen_pos_x, u_gen_pos_y) * 0.5;
    float t = u_time * u_gen_frequency;
    float dist = length(centered);
    float r = u_gen_size * 0.4;

    vec3 genColour = hsv2rgb(vec3(u_gen_hue, 0.8, 1.0));
    float v = 0.0;
    vec3 col = vec3(0.0);

    if (u_gen_type < 0.5) {
        // 0: off
        col = vec3(0.0);

    } else if (u_gen_type < 1.5) {
        // 1: Voronoi / Cellular
        float cellScale = 2.0 + u_gen_size * 10.0;
        vec2 cellUV = uv * cellScale;
        vec2 cellID = floor(cellUV);
        vec2 cellPos = fract(cellUV);
        float minDist = 1.0;
        for (float y = -1.0; y <= 1.0; y += 1.0) {
            for (float x = -1.0; x <= 1.0; x += 1.0) {
                vec2 neighbour = vec2(x, y);
                vec2 nID = cellID + neighbour;
                vec2 point = vec2(hash(nID), hash(nID + vec2(13.7, 27.3)));
                point = 0.5 + 0.4 * sin(point * 6.28318 + t);
                vec2 diff = neighbour + point - cellPos;
                float d = length(diff);
                minDist = min(minDist, d);
            }
        }
        v = smoothstep(0.0, u_gen_softness * 0.5 + 0.001, minDist);
        col = genColour * v;

    } else if (u_gen_type < 2.5) {
        // 2: Domain-Warped Noise
        float baseScale = 2.0 + u_gen_size * 8.0;
        float warpAmount = u_gen_softness * 2.0;
        vec2 warp = vec2(
            fbm(uv * baseScale + t * 0.5),
            fbm(uv * baseScale + t * 0.5 + vec2(5.2, 1.3))
        );
        v = smoothstep(0.4, 0.6, fbm(uv * baseScale + warp * warpAmount + t));
        col = genColour * v;

    } else if (u_gen_type < 3.5) {
        // 3: Outlined Shapes (circle, rectangle, diamond)
        float shapeType = mod(floor(u_gen_frequency * 0.5), 3.0);
        float thickness = u_gen_softness * 0.08 + 0.005;

        float circleRingDist = abs(dist - r);
        float circleOutline = 1.0 - smoothstep(0.0, thickness, circleRingDist);

        vec2 rectDist = abs(centered) - vec2(r);
        float rectEdgeDist = length(max(rectDist, 0.0)) + min(max(rectDist.x, rectDist.y), 0.0);
        float rectOutline = 1.0 - smoothstep(0.0, thickness, abs(rectEdgeDist));

        float diamondRingDist = abs(abs(centered.x) + abs(centered.y) - r);
        float diamondOutline = 1.0 - smoothstep(0.0, thickness, diamondRingDist);

        float isCircle  = step(shapeType, 0.5);
        float isRect    = step(0.5, shapeType) * step(shapeType, 1.5);
        float isDiamond = step(1.5, shapeType);

        v = circleOutline * isCircle + rectOutline * isRect + diamondOutline * isDiamond;
        col = genColour * v;

    } else if (u_gen_type < 4.5) {
        // 4: Diagonal Stripes / Grid
        float stripeSpacing = 5.0 + u_gen_size * 30.0;
        float angle = t * 0.5;
        vec2 dir = vec2(cos(angle), sin(angle));
        float stripe1 = sin(dot(centered, dir) * stripeSpacing);
        vec2 dirPerp = vec2(-dir.y, dir.x);
        float stripe2 = sin(dot(centered, dirPerp) * stripeSpacing) * 0.5;
        float stripePattern = (stripe1 + stripe2) * 0.5 + 0.5;
        v = smoothstep(0.5 - u_gen_softness * 0.3, 0.5 + u_gen_softness * 0.3, stripePattern);
        col = genColour * v;

    } else if (u_gen_type < 5.5) {
        // 5: Reaction-Diffusion Seed
        vec3 centre = texture2D(u_feedback, uv).rgb;
        float c = luminance(centre);
        float n1 = luminance(texture2D(u_feedback, uv + vec2(px.x, 0.0)).rgb);
        float n2 = luminance(texture2D(u_feedback, uv - vec2(px.x, 0.0)).rgb);
        float n3 = luminance(texture2D(u_feedback, uv + vec2(0.0, px.y)).rgb);
        float n4 = luminance(texture2D(u_feedback, uv - vec2(0.0, px.y)).rgb);
        float d1 = luminance(texture2D(u_feedback, uv + vec2(px.x, px.y)).rgb);
        float d2 = luminance(texture2D(u_feedback, uv - vec2(px.x, px.y)).rgb);
        float d3 = luminance(texture2D(u_feedback, uv + vec2(px.x, -px.y)).rgb);
        float d4 = luminance(texture2D(u_feedback, uv - vec2(px.x, -px.y)).rgb);
        float neighbors = (n1 + n2 + n3 + n4) * 0.25;
        float neighbors_all = (n1 + n2 + n3 + n4 + d1 + d2 + d3 + d4) * 0.125;
        float noise = fbm(uv * (5.0 + u_gen_size * 15.0) + t * u_gen_frequency * 0.2);
        float excitation = neighbors_all - c;
        float growthZone = smoothstep(0.0, 0.2, neighbors) * smoothstep(0.8, 0.6, neighbors);
        float diffused = mix(c, neighbors_all, u_gen_softness);
        float seed = noise * (1.0 - smoothstep(0.0, 0.3, c));
        float reaction = growthZone * 0.3 + excitation * u_gen_softness * 0.2;
        float decay = c * u_gen_frequency * 0.02;
        v = clamp(diffused + reaction + seed * 0.5 - decay, 0.0, 1.0);
        col = genColour * v;

    } else if (u_gen_type < 6.5) {
        // 6: Moire
        float scale1 = 20.0 + u_gen_size * 40.0;
        float scale2 = scale1 * 1.1;
        float p1 = sin(centered.x * scale1 + t) * sin(centered.y * scale1);
        float p2 = sin(centered.x * scale2 - t * 0.7) * sin(centered.y * scale2);
        v = smoothstep(0.5 - u_gen_softness * 0.3, 0.5 + u_gen_softness * 0.3,
                       (p1 + p2) * 0.5 + 0.5);
        col = genColour * v;

    } else {
        // 7: Image sampler
        float imgZoom = max(u_gen_size * 2.0, 0.01);
        vec2 imgUV = clamp(centered / imgZoom + 0.5, 0.0, 1.0);
        vec3 imgRaw = texture2D(u_gen_image, imgUV).rgb;
        vec3 imgHSV = rgb2hsv(imgRaw);
        imgHSV.x = fract(imgHSV.x + u_gen_hue);
        col = hsv2rgb(imgHSV);
    }

    col += vec3(u_gen_trigger);
    col *= u_gen_intensity;

    return col;
}


// ============================================================================
// EDGE DETECTION FUNCTIONS
// Intentionally uses if/else branching - computing all edge types branchlessly
// would require 8+ texture samples (Sobel) on every frame regardless of mode.
// The branch cost is far cheaper than wasted texture lookups on VideoCore IV.
// ============================================================================

// Roberts Cross - 3 samples (cheapest)
float edgeRoberts(vec2 uv, sampler2D tex) {
    float tl = luminance(texture2D(tex, uv).rgb);
    float br = luminance(texture2D(tex, uv + px).rgb);
    float tr = luminance(texture2D(tex, uv + vec2(px.x, 0.0)).rgb);
    float bl = luminance(texture2D(tex, uv + vec2(0.0, px.y)).rgb);

    float gx = tl - br;
    float gy = tr - bl;

    return sqrt(gx * gx + gy * gy);
}

// Simple Gradient - 4 samples (good balance)
float edgeGradient(vec2 uv, sampler2D tex) {
    float l = luminance(texture2D(tex, uv - vec2(px.x, 0.0)).rgb);
    float r = luminance(texture2D(tex, uv + vec2(px.x, 0.0)).rgb);
    float u = luminance(texture2D(tex, uv - vec2(0.0, px.y)).rgb);
    float d = luminance(texture2D(tex, uv + vec2(0.0, px.y)).rgb);

    float gx = r - l;
    float gy = d - u;

    return sqrt(gx * gx + gy * gy);
}

// Sobel - 8 samples (best quality, most expensive - use sparingly on Pi 3)
float edgeSobel(vec2 uv, sampler2D tex) {
    float tl = luminance(texture2D(tex, uv + vec2(-px.x, -px.y)).rgb);
    float tc = luminance(texture2D(tex, uv + vec2(0.0, -px.y)).rgb);
    float tr = luminance(texture2D(tex, uv + vec2(px.x, -px.y)).rgb);
    float ml = luminance(texture2D(tex, uv + vec2(-px.x, 0.0)).rgb);
    float mr = luminance(texture2D(tex, uv + vec2(px.x, 0.0)).rgb);
    float bl = luminance(texture2D(tex, uv + vec2(-px.x, px.y)).rgb);
    float bc = luminance(texture2D(tex, uv + vec2(0.0, px.y)).rgb);
    float br = luminance(texture2D(tex, uv + vec2(px.x, px.y)).rgb);

    float gx = -tl - 2.0*ml - bl + tr + 2.0*mr + br;
    float gy = -tl - 2.0*tc - tr + bl + 2.0*bc + br;

    return sqrt(gx * gx + gy * gy);
}

// Temporal - 1 sample (essentially free, motion-reactive)
float edgeTemporal(vec2 uv, vec3 current, sampler2D feedbackTex) {
    float currentLum = luminance(current);
    float previousLum = luminance(texture2D(feedbackTex, uv).rgb);
    return abs(currentLum - previousLum);
}

vec3 applyEdgeDetection(vec3 col, vec2 uv, sampler2D tex, float isTemporal) {
    // Early exit if edge detection is off - this branch is worth it
    // because it skips all texture lookups entirely
    if (u_edge_type < 0.5) return col;

    float edge = 0.0;

    // Branching on edge type is intentional - avoids 8 wasted Sobel samples
    if (u_edge_type < 1.5) {
        edge = edgeRoberts(uv, tex);
    }
    else if (u_edge_type < 2.5) {
        edge = edgeGradient(uv, tex);
    }
    else if (u_edge_type < 3.5) {
        edge = edgeSobel(uv, tex);
    }
    else if (isTemporal > 0.5) {
        edge = edgeTemporal(uv, col, tex);
    }

    // Apply threshold
    edge = smoothstep(u_edge_threshold * 0.5, u_edge_threshold * 0.5 + 0.1, edge);

    // Edge colour modes (branchless)
    float isWhite   = step(u_edge_colour_mode, 0.5);                                    // mode 0
    float isColoured = step(0.5, u_edge_colour_mode) * step(u_edge_colour_mode, 1.5);   // mode 1
    float isTinted  = step(1.5, u_edge_colour_mode);                                    // mode 2

    vec3 edgeCol = vec3(edge) * isWhite
                 + col * edge * isColoured
                 + (col + vec3(edge)) * isTinted;

    return mix(col, edgeCol, u_edge_mix);
}


// ============================================================================
// EFFECTS FUNCTIONS (branchless)
// ============================================================================

vec3 posterize(vec3 col) {
    float doP = step(2.0, u_fx_posterize);
    float levels = max(u_fx_posterize, 2.0);
    vec3 posterized = floor(col * levels) / (levels - 1.0);
    posterized = mix(posterized, col, u_fx_posterize_smooth * 0.5);
    return mix(col, posterized, doP);
}

vec3 solarize(vec3 col) {
    if (u_fx_solarize < 0.01) return col;

    if (u_fx_solarize_mode < 0.5) {
        vec3 mask = smoothstep(u_fx_solarize - u_fx_solarize_soft * 0.2,
                               u_fx_solarize + u_fx_solarize_soft * 0.2, col);
        return mix(col, 1.0 - col, mask);
    }
    if (u_fx_solarize_mode < 1.5)
        return 1.0 - abs(col * 2.0 - 1.0);

    vec3 folded = abs(abs(col * 4.0 - 2.0) - 1.0);
    return mix(col, folded, 0.5 + u_fx_solarize_soft * 0.5);
}

vec3 thresholdEffect(vec3 col) {
    float doT = step(0.01, u_fx_threshold);
    float lum = luminance(col);
    vec3 threshed = vec3(step(u_fx_threshold, lum));
    return mix(col, threshed, doT);
}

vec2 pixelateUV(vec2 uv) {
    if (u_fx_pixelate < 1.5) return uv;
    vec2 pixelSize = vec2(u_fx_pixelate) / u_resolution;
    return floor(uv / pixelSize) * pixelSize + pixelSize * 0.5;
}

vec3 applyEffects(vec3 col) {
    if (u_fx_posterize < 2.0 && u_fx_solarize < 0.01 && u_fx_threshold < 0.01)
        return col;
    col = posterize(col);
    col = solarize(col);
    col = thresholdEffect(col);
    return col;
}


// ============================================================================
// COLOUR PROCESSING
// ============================================================================

vec3 processColour(vec3 col) {
    // Skip the expensive HSV round-trip when hue and saturation are at defaults
    bool needHSV = (u_col_hue_shift > 0.001 || abs(u_col_saturation - 1.0) > 0.001);
    if (needHSV) {
        vec3 hsv = rgb2hsv(col);
        hsv.x = fract(hsv.x + u_col_hue_shift);
        hsv.y = clamp(hsv.y * u_col_saturation, 0.0, 1.0);
        col = hsv2rgb(hsv);
    }

    if (abs(u_col_brightness) > 0.001)
        col += u_col_brightness;

    if (abs(u_col_contrast - 1.0) > 0.001)
        col = (col - 0.5) * u_col_contrast + 0.5;

    if (u_col_invert > 0.001)
        col = mix(col, 1.0 - col, u_col_invert);

    return clamp(col, 0.0, 1.0);
}

vec3 applyRGBSeparation(vec2 uv, sampler2D tex) {
    if (u_col_rgb_sep < 0.001) {
        return texture2D(tex, uv).rgb;
    }
    float r = texture2D(tex, uv + vec2(u_col_rgb_sep, 0.0)).r;
    float g = texture2D(tex, uv).g;
    float b = texture2D(tex, uv - vec2(u_col_rgb_sep, 0.0)).b;
    return vec3(r, g, b);
}


// ============================================================================
// BLEND MODES (branchless)
// ============================================================================

vec3 blendColours(vec3 generator, vec3 feedback) {
    if (u_blend_mode < 0.5)
        return mix(feedback, generator, u_gen_intensity);
    if (u_blend_mode < 1.5)
        return feedback + generator;
    if (u_blend_mode < 2.5)
        return feedback * (generator + 0.5);
    if (u_blend_mode < 3.5)
        return 1.0 - (1.0 - feedback) * (1.0 - generator);
    if (u_blend_mode < 4.5)
        return abs(feedback - generator);
    // overlay
    vec3 low  = 2.0 * feedback * generator;
    vec3 high = 1.0 - 2.0 * (1.0 - feedback) * (1.0 - generator);
    return mix(low, high, step(0.5, feedback));
}


// ============================================================================
// POST-PROCESSING (shared texture samples for blur/sharpen)
// ============================================================================

vec3 postProcess(vec3 col, vec2 uv) {
    // Only sample neighbours when blur or sharpen is actually active.
    // On Pi 3 this saves ~4 texture samples per pixel at default settings.
    if (u_post_blur > 0.01 || u_post_sharpen > 0.01) {
        float blurSize = max(u_post_blur * 3.0, 1.0);
        vec3 nR = texture2D(u_feedback, uv + vec2(px.x, 0.0) * blurSize).rgb;
        vec3 nL = texture2D(u_feedback, uv - vec2(px.x, 0.0) * blurSize).rgb;
        vec3 nU = texture2D(u_feedback, uv + vec2(0.0, px.y) * blurSize).rgb;
        vec3 nD = texture2D(u_feedback, uv - vec2(0.0, px.y) * blurSize).rgb;
        vec3 avg = (col + nR + nL + nU + nD) / 5.0;

        col = mix(col, avg, u_post_blur);

        vec3 sharpened = col + (col - avg) * u_post_sharpen * 2.0;
        col = mix(col, sharpened, step(0.01, u_post_sharpen));
    }

    // Noise (branchless)
    float n = hash(uv * u_resolution + u_time * 1000.0) - 0.5;
    col += n * u_post_noise;

    // Soft clipping - uses tanhApprox instead of tanh() for GLSL ES 1.00
    float drive = 1.0 + u_post_soft_clip * 4.0;  // 1.0 to 5.0
    vec3 clipped = tanhApprox(col * drive) / tanhApprox(vec3(drive));
    col = mix(col, clipped, u_post_soft_clip);

    return clamp(col, 0.0, 1.0);
}


// ============================================================================
// MAIN
// ============================================================================

void main() {
    // Calculate pixel size for sampling offsets
    px = 1.0 / u_resolution;

    vec2 uv = gl_FragCoord.xy / u_resolution;

    // Apply pixelation to UV if enabled (branchless)
    vec2 pixUV = pixelateUV(uv);

    // -------------------------------------------------------------------------
    // 1. Sample feedback buffer with transforms
    // -------------------------------------------------------------------------
    vec2 fb_uv = applyTransforms(pixUV);

    // Wrap feedback UV
    fb_uv = fract(fb_uv);

    // Sample with RGB separation
    vec3 feedback = applyRGBSeparation(fb_uv, u_feedback);

    // -------------------------------------------------------------------------
    // 1a. UV Displacement from feedback luminance
    // -------------------------------------------------------------------------
    if (u_tf_displace > 0.001) {
        float fb_lum = luminance(feedback);
        vec2 displaced_uv = fract(fb_uv + (fb_lum - 0.5) * u_tf_displace);
        feedback = applyRGBSeparation(displaced_uv, u_feedback);
    }

    // -------------------------------------------------------------------------
    // 1b. Multiple feedback taps
    // -------------------------------------------------------------------------
    if (u_fb_tap2_amount > 0.01) {
        vec2 centered2 = pixUV - 0.5;
        centered2 /= u_tf_scale;
        float totalRot = u_tf_rotation + u_fb_tap2_offset;
        float s2 = sin(totalRot);
        float c2 = cos(totalRot);
        centered2 = vec2(
            centered2.x * c2 - centered2.y * s2,
            centered2.x * s2 + centered2.y * c2
        );
        centered2 -= vec2(u_tf_translate_x, u_tf_translate_y);
        vec2 fb_uv2 = fract(applyMirror(centered2 + 0.5));
        vec3 feedback2 = texture2D(u_feedback, fb_uv2).rgb;
        feedback = mix(feedback, feedback2, u_fb_tap2_amount);
    }

    // -------------------------------------------------------------------------
    // 1c. Long-delay feedback buffer
    // -------------------------------------------------------------------------
    if (u_fb_delay_amount > 0.01) {
        vec3 delayed = texture2D(u_delay_feedback, fb_uv).rgb;
        feedback = mix(feedback, delayed, u_fb_delay_amount);
    }

    // -------------------------------------------------------------------------
    // 2. Apply pre-feedback edge detection (if enabled)
    //    Uses branching intentionally to avoid wasted Sobel samples
    // -------------------------------------------------------------------------
    if (u_edge_pre_fb > 0.5 && u_edge_type < 3.5) {
        feedback = applyEdgeDetection(feedback, fb_uv, u_feedback, 0.0);
    }

    // -------------------------------------------------------------------------
    // 3. Apply pre-feedback effects (if enabled)
    // -------------------------------------------------------------------------
    // Branchless: effects functions are internally branchless and nearly free
    // when their control values are at defaults (0 posterize, 0 solarize, etc.)
    vec3 preFx = applyEffects(feedback);
    feedback = mix(feedback, preFx, step(0.5, u_fx_pre_fb));

    // -------------------------------------------------------------------------
    // 4. Colour processing on feedback
    // -------------------------------------------------------------------------
    feedback = processColour(feedback);

    // -------------------------------------------------------------------------
    // 5. Apply decay
    // -------------------------------------------------------------------------
    feedback *= u_fb_decay;

    // -------------------------------------------------------------------------
    // 6. Generate internal source
    // -------------------------------------------------------------------------
    // Pass both pixel UV and feedback UV (needed for reaction-diffusion generator)
    vec3 generator = generateSource(pixUV, fb_uv);

    // -------------------------------------------------------------------------
    // 7. Blend generator with feedback (branchless)
    // -------------------------------------------------------------------------
    vec3 result = blendColours(generator, feedback * u_fb_amount);

    // -------------------------------------------------------------------------
    // 8. Post-feedback edge detection (if not pre)
    // -------------------------------------------------------------------------
    if (u_edge_pre_fb < 0.5) {
        result = applyEdgeDetection(result, uv, u_feedback, 1.0);
    }

    // -------------------------------------------------------------------------
    // 9. Post-feedback effects (if not pre)
    // -------------------------------------------------------------------------
    vec3 postFx = applyEffects(result);
    result = mix(postFx, result, step(0.5, u_fx_pre_fb));

    // -------------------------------------------------------------------------
    // 10. Post-processing
    // -------------------------------------------------------------------------
    result = postProcess(result, uv);

    // -------------------------------------------------------------------------
    // Output
    // -------------------------------------------------------------------------
    gl_FragColor = vec4(result, 1.0);
}
