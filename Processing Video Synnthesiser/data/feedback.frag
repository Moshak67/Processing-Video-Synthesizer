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
    // Branchless mirror mode selection using step() masks
    float isH   = step(0.5, u_tf_mirror) * step(u_tf_mirror, 1.5);  // mode 1
    float isV   = step(1.5, u_tf_mirror) * step(u_tf_mirror, 2.5);  // mode 2
    float isQ   = step(2.5, u_tf_mirror) * step(u_tf_mirror, 3.5);  // mode 3
    float isK   = step(3.5, u_tf_mirror);                            // mode 4

    // Horizontal mirror (modes 1, 3)
    float doH = max(isH, isQ);
    uv.x = mix(uv.x, abs(uv.x - 0.5) + 0.5, doH);

    // Vertical mirror (modes 2, 3)
    float doV = max(isV, isQ);
    uv.y = mix(uv.y, abs(uv.y - 0.5) + 0.5, doV);

    // Kaleidoscope (mode 4) - compute unconditionally, blend via isK
    vec2 centered = uv - 0.5;
    float angle = atan(centered.y, centered.x);
    float segments = 6.0;
    angle = mod(angle, 6.28318 / segments);
    angle = abs(angle - 3.14159 / segments);
    float radius = length(centered);
    vec2 kalUV = vec2(cos(angle), sin(angle)) * radius + 0.5;
    uv = mix(uv, kalUV, isK);

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
    float sf = u_gen_softness * 0.1 + 0.001;

    // Generator colour from hue
    vec3 genColour = hsv2rgb(vec3(u_gen_hue, 0.8, 1.0));

    // Type selection masks
    float t1 = step(0.5, u_gen_type) * step(u_gen_type, 1.5);  // voronoi
    float t2 = step(1.5, u_gen_type) * step(u_gen_type, 2.5);  // domain-warped noise
    float t3 = step(2.5, u_gen_type) * step(u_gen_type, 3.5);  // noise (unchanged)
    float t4 = step(3.5, u_gen_type) * step(u_gen_type, 4.5);  // diagonal stripes
    float t5 = step(4.5, u_gen_type) * step(u_gen_type, 5.5);  // reaction-diffusion
    float t6 = step(5.5, u_gen_type) * step(u_gen_type, 6.5);  // moire (type 6 only)
    float t7 = step(6.5, u_gen_type);                           // image sampler (type 7)

    // 1. Voronoi / Cellular
    // Tile-based nearest-point distance field with animated cell centres
    float cellScale = 2.0 + u_gen_size * 10.0;
    vec2 cellUV = uv * cellScale;
    vec2 cellID = floor(cellUV);
    vec2 cellPos = fract(cellUV);

    float minDist = 1.0;
    // 3x3 neighbour search for nearest cell centre
    for (float y = -1.0; y <= 1.0; y += 1.0) {
        for (float x = -1.0; x <= 1.0; x += 1.0) {
            vec2 neighbour = vec2(x, y);
            vec2 nID = cellID + neighbour;
            // Random point in neighbouring cell (animated by frequency)
            vec2 point = vec2(hash(nID), hash(nID + vec2(13.7, 27.3)));
            point = 0.5 + 0.4 * sin(point * 6.28318 + t);
            vec2 diff = neighbour + point - cellPos;
            float d = length(diff);
            minDist = min(minDist, d);
        }
    }
    float v1 = smoothstep(0.0, u_gen_softness * 0.5 + 0.001, minDist);

    // 2. Domain-Warped Noise
    // Feed noise output as UV offset for second noise pass
    float baseScale = 2.0 + u_gen_size * 8.0;
    float warpAmount = u_gen_softness * 2.0;
    vec2 warp = vec2(
        fbm(uv * baseScale + t * 0.5),
        fbm(uv * baseScale + t * 0.5 + vec2(5.2, 1.3))
    );
    float v2 = smoothstep(0.4, 0.6,
                          fbm(uv * baseScale + warp * warpAmount + t));

    // 3. Outlined Shapes (circle, rectangle, diamond)
    // Use frequency to select shape type and animate
    float shapeType = mod(floor(u_gen_frequency * 0.5), 3.0);  // 0=circle, 1=rect, 2=diamond
    float thickness = u_gen_softness * 0.08 + 0.005;  // outline thickness
    float shapeSize = r;  // reuse radius calculation

    // Circle outline - HOLLOW ring only
    // Distance from the circle radius (0 when exactly on the circle)
    float circleRingDist = abs(dist - shapeSize);
    // Show only when close to the ring (inverted smoothstep)
    float circleOutline = 1.0 - smoothstep(0.0, thickness, circleRingDist);

    // Rectangle outline - HOLLOW edges only
    vec2 rectDist = abs(centered) - vec2(shapeSize);
    float rectEdgeDist = length(max(rectDist, 0.0)) + min(max(rectDist.x, rectDist.y), 0.0);
    // Distance from rectangle edge (0 when exactly on edge)
    float rectRingDist = abs(rectEdgeDist);
    float rectOutline = 1.0 - smoothstep(0.0, thickness, rectRingDist);

    // Diamond outline - HOLLOW edges only
    // Manhattan distance gives diamond shape
    float diamondDist = abs(centered.x) + abs(centered.y) - shapeSize;
    float diamondRingDist = abs(diamondDist);
    float diamondOutline = 1.0 - smoothstep(0.0, thickness, diamondRingDist);

    // Select shape based on frequency parameter
    float isCircle = step(shapeType, 0.5);
    float isRect = step(0.5, shapeType) * step(shapeType, 1.5);
    float isDiamond = step(1.5, shapeType);

    float v3 = circleOutline * isCircle + rectOutline * isRect + diamondOutline * isDiamond;

    // 4. Diagonal Stripes / Grid
    // Rotating stripes with controllable angle and softness
    float stripeSpacing = 5.0 + u_gen_size * 30.0;
    float angle = t * 0.5;
    vec2 dir = vec2(cos(angle), sin(angle));
    float stripe1 = sin(dot(centered, dir) * stripeSpacing);
    // Add perpendicular stripe at half intensity for grid effect
    vec2 dirPerp = vec2(-dir.y, dir.x);
    float stripe2 = sin(dot(centered, dirPerp) * stripeSpacing) * 0.5;
    float stripePattern = (stripe1 + stripe2) * 0.5 + 0.5;
    float v4 = smoothstep(0.5 - u_gen_softness * 0.3, 0.5 + u_gen_softness * 0.3, stripePattern);

    // 5. Reaction-Diffusion Seed
    // Simplified organic growth pattern inspired by reaction-diffusion
    // Reads feedback and applies local rules to create evolving organic patterns

    // Sample center and neighbors from feedback
    vec3 centre = texture2D(u_feedback, uv).rgb;
    float c = luminance(centre);

    float n1 = luminance(texture2D(u_feedback, uv + vec2(px.x, 0.0)).rgb);
    float n2 = luminance(texture2D(u_feedback, uv - vec2(px.x, 0.0)).rgb);
    float n3 = luminance(texture2D(u_feedback, uv + vec2(0.0, px.y)).rgb);
    float n4 = luminance(texture2D(u_feedback, uv - vec2(0.0, px.y)).rgb);

    // Also sample diagonals for richer patterns
    float d1 = luminance(texture2D(u_feedback, uv + vec2(px.x, px.y)).rgb);
    float d2 = luminance(texture2D(u_feedback, uv - vec2(px.x, px.y)).rgb);
    float d3 = luminance(texture2D(u_feedback, uv + vec2(px.x, -px.y)).rgb);
    float d4 = luminance(texture2D(u_feedback, uv - vec2(px.x, -px.y)).rgb);

    // Compute neighbor average and variance
    float neighbors = (n1 + n2 + n3 + n4) * 0.25;
    float neighbors_all = (n1 + n2 + n3 + n4 + d1 + d2 + d3 + d4) * 0.125;

    // Noise for seeding and randomness (stronger)
    float noise = fbm(uv * (5.0 + u_gen_size * 15.0) + t * u_gen_frequency * 0.2);

    // Compute excitation (how active neighbors are)
    float excitation = (neighbors_all - c);  // positive if neighbors brighter than center

    // Growth rules (cellular automaton style)
    float threshold = 0.2 + u_gen_size * 0.3;  // sweet spot for growth
    float growthZone = smoothstep(0.0, 0.2, neighbors) * smoothstep(0.8, 0.6, neighbors);

    // Diffusion with neighbors (controlled by softness)
    float diffused = mix(c, neighbors_all, u_gen_softness);

    // Strong noise seed to get things started
    float seed = noise * (1.0 - smoothstep(0.0, 0.3, c));  // seed where dark

    // Reaction term: grow in the sweet spot, strengthen existing bright areas
    float reaction = growthZone * 0.3 + excitation * u_gen_softness * 0.2;

    // Decay based on frequency (prevents runaway brightness)
    float decay = c * u_gen_frequency * 0.02;

    // Combine all terms
    float v5 = diffused + reaction + seed * 0.5 - decay;

    v5 = clamp(v5, 0.0, 1.0);

    // 6. Moire (unchanged from original)
    float scale1 = 20.0 + u_gen_size * 40.0;
    float scale2 = scale1 * 1.1;
    float p1 = sin(centered.x * scale1 + t) * sin(centered.y * scale1);
    float p2 = sin(centered.x * scale2 - t * 0.7) * sin(centered.y * scale2);
    float v6 = smoothstep(0.5 - u_gen_softness * 0.3, 0.5 + u_gen_softness * 0.3,
                           (p1 + p2) * 0.5 + 0.5);

    // 7. Image sampler
    // gen_size controls zoom (0.5 = fill screen, lower = zoom in, higher = zoom out)
    // gen_pos_x/y pans the image via 'centered' which already includes position offset
    float imgZoom = max(u_gen_size * 2.0, 0.01);      // 0.5 default → 1.0 = fill screen
    vec2 imgUV = centered / imgZoom + 0.5;             // reuse existing 'centered' var
    imgUV = clamp(imgUV, 0.0, 1.0);                    // clamp: no tiling, black border on overrun
    vec3 imgRaw = texture2D(u_gen_image, imgUV).rgb;

    // Apply hue shift
    vec3 imgHSV = rgb2hsv(imgRaw);
    imgHSV.x = fract(imgHSV.x + u_gen_hue);
    vec3 v7_col = hsv2rgb(imgHSV);

    // Branchless weighted sum
    float v = v1*t1 + v2*t2 + v3*t3 + v4*t4 + v5*t5 + v6*t6;

    vec3 col = genColour * v;
    col = mix(col, v7_col, t7);   // branchless: replace with image when type 7

    // Apply trigger flash
    col += vec3(u_gen_trigger);

    // Apply intensity
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
    float doS = step(0.01, u_fx_solarize);
    float thresh = u_fx_solarize;

    // Mode masks
    float m0 = step(u_fx_solarize_mode, 0.5);                                    // classic
    float m1 = step(0.5, u_fx_solarize_mode) * step(u_fx_solarize_mode, 1.5);   // symmetric
    float m2 = step(1.5, u_fx_solarize_mode);                                    // multi

    // Classic: invert above threshold
    vec3 mask = smoothstep(thresh - u_fx_solarize_soft * 0.2,
                           thresh + u_fx_solarize_soft * 0.2, col);
    vec3 s0 = mix(col, 1.0 - col, mask);

    // Symmetric V-shape
    vec3 s1 = 1.0 - abs(col * 2.0 - 1.0);

    // Multi-fold
    vec3 folded = abs(abs(col * 4.0 - 2.0) - 1.0);
    vec3 s2 = mix(col, folded, 0.5 + u_fx_solarize_soft * 0.5);

    vec3 solarized = s0 * m0 + s1 * m1 + s2 * m2;
    return mix(col, solarized, doS);
}

vec3 thresholdEffect(vec3 col) {
    float doT = step(0.01, u_fx_threshold);
    float lum = luminance(col);
    vec3 threshed = vec3(step(u_fx_threshold, lum));
    return mix(col, threshed, doT);
}

vec2 pixelateUV(vec2 uv) {
    float doP = step(1.5, u_fx_pixelate);
    vec2 pixelSize = vec2(u_fx_pixelate) / u_resolution;
    vec2 pixelated = floor(uv / pixelSize) * pixelSize + pixelSize * 0.5;
    return mix(uv, pixelated, doP);
}

vec3 applyEffects(vec3 col) {
    col = posterize(col);
    col = solarize(col);
    col = thresholdEffect(col);
    return col;
}


// ============================================================================
// COLOUR PROCESSING
// ============================================================================

vec3 processColour(vec3 col) {
    // Convert to HSV for hue/sat manipulation
    vec3 hsv = rgb2hsv(col);

    // Hue shift
    hsv.x = fract(hsv.x + u_col_hue_shift);

    // Saturation
    hsv.y = clamp(hsv.y * u_col_saturation, 0.0, 1.0);

    // Convert back to RGB
    col = hsv2rgb(hsv);

    // Brightness
    col += u_col_brightness;

    // Contrast (around 0.5 midpoint)
    col = (col - 0.5) * u_col_contrast + 0.5;

    // Inversion
    col = mix(col, 1.0 - col, u_col_invert);

    return clamp(col, 0.0, 1.0);
}

vec3 applyRGBSeparation(vec2 uv, sampler2D tex) {
    // Branchless: when sep is 0, all three sample the same UV (no visual change)
    float sep = u_col_rgb_sep;
    float doSep = step(0.001, sep);
    float offset = sep * doSep;

    float r = texture2D(tex, uv + vec2(offset, 0.0)).r;
    float g = texture2D(tex, uv).g;
    float b = texture2D(tex, uv - vec2(offset, 0.0)).b;

    return vec3(r, g, b);
}


// ============================================================================
// BLEND MODES (branchless)
// ============================================================================

vec3 blendColours(vec3 generator, vec3 feedback) {
    // Mode masks
    float m0 = step(u_blend_mode, 0.5);                                    // mix
    float m1 = step(0.5, u_blend_mode) * step(u_blend_mode, 1.5);         // add
    float m2 = step(1.5, u_blend_mode) * step(u_blend_mode, 2.5);         // multiply
    float m3 = step(2.5, u_blend_mode) * step(u_blend_mode, 3.5);         // screen
    float m4 = step(3.5, u_blend_mode) * step(u_blend_mode, 4.5);         // difference
    float m5 = step(4.5, u_blend_mode);                                    // overlay

    vec3 rMix    = mix(feedback, generator, u_gen_intensity);
    vec3 rAdd    = feedback + generator;
    vec3 rMul    = feedback * (generator + 0.5);
    vec3 rScreen = 1.0 - (1.0 - feedback) * (1.0 - generator);
    vec3 rDiff   = abs(feedback - generator);
    vec3 rOvLow  = 2.0 * feedback * generator;
    vec3 rOvHigh = 1.0 - 2.0 * (1.0 - feedback) * (1.0 - generator);
    vec3 rOvr    = mix(rOvLow, rOvHigh, step(0.5, feedback));

    return rMix * m0 + rAdd * m1 + rMul * m2 + rScreen * m3 + rDiff * m4 + rOvr * m5;
}


// ============================================================================
// POST-PROCESSING (shared texture samples for blur/sharpen)
// ============================================================================

vec3 postProcess(vec3 col, vec2 uv) {
    // Determine if we need neighbour samples at all
    // Blur and sharpen both need the same 4 cardinal neighbours
    float needSamples = step(0.01, u_post_blur) + step(0.01, u_post_sharpen);

    // Sample neighbours once, shared between blur and sharpen
    // When neither is active, these reads still happen but the result is discarded
    // via mix(col, ..., 0.0). On Pi 3 this is cheaper than branching + pipeline stall.
    float blurSize = max(u_post_blur * 3.0, 1.0);
    vec3 nR = texture2D(u_feedback, uv + vec2(px.x, 0.0) * blurSize).rgb;
    vec3 nL = texture2D(u_feedback, uv - vec2(px.x, 0.0) * blurSize).rgb;
    vec3 nU = texture2D(u_feedback, uv + vec2(0.0, px.y) * blurSize).rgb;
    vec3 nD = texture2D(u_feedback, uv - vec2(0.0, px.y) * blurSize).rgb;
    vec3 avg = (col + nR + nL + nU + nD) / 5.0;

    // Blur: mix toward average
    col = mix(col, avg, u_post_blur * step(0.01, u_post_blur));

    // Sharpen: unsharp mask = original + (original - blurred) * amount
    vec3 sharpened = col + (col - avg) * u_post_sharpen * 2.0;
    col = mix(col, sharpened, step(0.01, u_post_sharpen));

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
    // Compute luminance and use it to offset UV, then re-sample
    // When u_tf_displace is 0, displaced_uv == fb_uv (no visual change)
    float fb_lum = luminance(feedback);
    vec2 displaced_uv = fb_uv + (fb_lum - 0.5) * u_tf_displace;
    displaced_uv = fract(displaced_uv);
    // Re-sample feedback at displaced position (adds up to 3 texture samples for RGB sep)
    feedback = applyRGBSeparation(displaced_uv, u_feedback);

    // -------------------------------------------------------------------------
    // 1b. Multiple feedback taps
    // -------------------------------------------------------------------------
    // Second feedback tap with offset rotation
    // Compute fb_uv2 with additional rotation offset
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
    vec2 fb_uv2 = centered2 + 0.5;
    fb_uv2 = applyMirror(fb_uv2);
    fb_uv2 = fract(fb_uv2);
    vec3 feedback2 = texture2D(u_feedback, fb_uv2).rgb;
    // Blend second tap (when amount is 0, this is branchless no-op)
    feedback = mix(feedback, feedback2, u_fb_tap2_amount);

    // -------------------------------------------------------------------------
    // 1c. Long-delay feedback buffer
    // -------------------------------------------------------------------------
    // Blend in the delay buffer (sampled at same UV as primary feedback)
    vec3 delayed = texture2D(u_delay_feedback, fb_uv).rgb;
    feedback = mix(feedback, delayed, u_fb_delay_amount);

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
