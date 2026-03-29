// ============================================================================
// FEEDBACK SHADER TEST SKETCH
// ============================================================================
// Processing sketch for testing the analog video feedback shader.
// Optimised for Raspberry Pi 3 deployment.
//
// Pi 3 optimisations (v2 — raw GL texture ping-pong):
//   - Single GL context: raw GL textures + FBO instead of 3× P2D PGraphics
//   - Delay buffer updated by pointer swap (no pixel copy / glFinish stall)
//   - HUD pre-rendered to JAVA2D PGraphics, redrawn only when hudDirty=true
//   - Render resolution reduced to 256×144 (~32ms GPU, fits 30fps budget)
//   - Reaction-diffusion generator removed (was 9× texture samples per pixel)
//
// Controls (no conflicts - lowercase=primary, SHIFT=secondary):
//   --- Generator ---
//   1-6            : Generator types (voronoi, domain-warped, outlined-shapes, stripes, moire, image)
//   z/x            : Generator frequency -/+
//   c/v            : Generator size -/+
//   b/n            : Generator pos X -/+
//   ,/.            : Generator pos Y -/+
//   ;/'            : Generator softness +/-
//   [/]            : Generator hue -/+
//   +/-            : Generator intensity +/-
//   SPACE          : Trigger flash
//
//   --- Feedback ---
//   q/a            : Feedback amount +/-
//   w/s            : Decay +/-
//   Shift+Q / Shift+W : Tap2 amount +/-
//   Shift+E / Shift+R : Tap2 offset +/-
//   Shift+T        : Delay amount +
//   Shift+Y        : Displace amount +
//
//   --- Transform ---
//   e/d            : Scale +/-
//   r/f            : Rotation +/-
//   m              : Mirror mode cycle
//
//   --- Colour ---
//   t/g            : Hue shift +/-
//   Shift+S / Shift+D  : Saturation +/-
//   Shift+F / Shift+G  : Brightness +/-
//   Shift+H / Shift+J  : Contrast +/-
//   Shift+K / Shift+L  : RGB separation +/-
//   Shift+; / Shift+'  : Invert +/-
//
//   --- Edge Detection ---
//   y/h            : Edge type cycle +/-
//   u/j            : Edge mix +/-
//   7/8            : Edge threshold +/-
//   9              : Edge colour mode cycle
//   p              : Edge pre-feedback toggle
//
//   --- Effects ---
//   i/k            : Posterize levels +/-
//   o/l            : Solarize amount +/-
//   Shift+Z / Shift+X  : Threshold +/-
//   Shift+C / Shift+V  : Pixelate +/-
//   Shift+A            : Effects pre-feedback toggle
//
//   --- Blend & Post ---
//   Shift+B        : Blend mode cycle
//   Shift+N        : Blur +
//   Shift+M        : Noise +
//   <              : Soft clip +
//   >              : Sharpen +
//
//   --- Utility ---
//   BACKSPACE      : Clear buffers
//   0              : Reset to defaults
//   Shift+1..6 (!, @, #, $, %, ^): Load presets
//   TAB            : Toggle HUD display
// ============================================================================

import processing.opengl.*;
import java.nio.IntBuffer;

// MIDI handled via MidiHandler.java (pure Java, bypasses Processing preprocessor)
MidiHandler midiHandler;

PShader feedbackShader;
PShader blitShader;

// Raw GL resources (initialised in first draw() call)
int[] texIds  = new int[3];  // [0]=bufA, [1]=bufB, [2]=delay
int   fboId   = -1;
boolean glReady = false;
int currentTex = 0;          // index into texIds for current write target

// Source image raw GL texture ID (0 = not yet extracted)
int sourceImgTexId = 0;

// HUD cache
PGraphics hudCache;
boolean hudDirty = true;

// Render resolution (independent of window size for Pi 3 performance)
final int RENDER_W = 256;
final int RENDER_H = 144;

// HUD control
boolean showHUD = true;

// Fullscreen toggle
boolean isFullScreen = false;
final int WINDOW_W = 1280;
final int WINDOW_H = 720;

int frameCounter = 0;

// MIDI thread safety
volatile boolean midiDirty = false;

ArrayList<String> imageFiles = new ArrayList<String>();
int currentImageIndex = 0;
PImage sourceImage;  // Currently loaded image (resized to RENDER_W × RENDER_H)

// Parameters with defaults
float gen_type = 1;
float gen_frequency = 1.0;
float gen_size = 0.3;
float gen_pos_x = 0.0;
float gen_pos_y = 0.0;
float gen_softness = 0.5;
float gen_hue = 0.0;
float gen_intensity = 0.5;
float gen_trigger = 0.0;

float fb_amount = 0.9;
float fb_decay = 0.98;
float fb_tap2_amount = 0.0;
float fb_tap2_offset = 0.0;
float fb_delay_amount = 0.0;

float tf_scale = 1.01;
float tf_rotation = 0.01;
float tf_translate_x = 0.0;
float tf_translate_y = 0.0;
float tf_mirror = 0;
float tf_displace = 0.0;

float edge_type = 0;
float edge_mix = 0.5;
float edge_threshold = 0.1;
float edge_colour_mode = 0;
float edge_pre_fb = 0;

float fx_posterize = 0;
float fx_posterize_smooth = 0.0;
float fx_solarize = 0.0;
float fx_solarize_soft = 0.5;
float fx_solarize_mode = 0;
float fx_threshold = 0.0;
float fx_pixelate = 1.0;
float fx_pre_fb = 0;

float col_hue_shift = 0.0;
float col_saturation = 1.0;
float col_brightness = 0.0;
float col_contrast = 1.0;
float col_rgb_sep = 0.0;
float col_invert = 0.0;

float blend_mode = 0;

float post_blur = 0.0;
float post_noise = 0.0;
float post_soft_clip = 0.0;
float post_sharpen = 0.0;


void setup() {
  size(1280, 720, P2D);
  noSmooth();
}

void setup() {
  // Set high so JOGL's animator doesn't sleep between frames.
  frameRate(120);

  feedbackShader = loadShader("feedback.frag", "passthrough.vert");

  // Create ping-pong buffers at reduced render resolution
  buffers[0] = createGraphics(RENDER_W, RENDER_H, P2D);
  buffers[1] = createGraphics(RENDER_W, RENDER_H, P2D);
  delayBuffer = createGraphics(RENDER_W, RENDER_H, P2D);

  // Clear buffers
  clearBuffers();

  // Image library for generator type 6
  loadImageLibrary();
  if (imageFiles.size() > 0) loadImageByIndex(0);

  // Initialise MIDI
  midiHandler = new MidiHandler(this, 3);
  midiHandler.init();

  println("Feedback Shader — Pi 3 Optimised (v2 raw GL)");
  println("Render: " + RENDER_W + "x" + RENDER_H + " @ 30fps → " + width + "x" + height);
  println("1-6: Gen | q/a: FB | w/s: Decay | e/d: Scale | r/f: Rot");
  println("0: Reset | TAB: HUD | BACKSPACE: Clear | !-^: Presets");
}


// ============================================================================
// GL RESOURCE INITIALISATION (called once from first draw())
// ============================================================================

void initGL() {
  PGL pgl = beginPGL();

  // Generate 3 textures: bufA, bufB, delay
  IntBuffer tb = IntBuffer.allocate(3);
  pgl.genTextures(3, tb);
  texIds[0] = tb.get(0);
  texIds[1] = tb.get(1);
  texIds[2] = tb.get(2);

  for (int id : texIds) {
    pgl.bindTexture(PGL.TEXTURE_2D, id);
    pgl.texImage2D(PGL.TEXTURE_2D, 0, PGL.RGBA, RENDER_W, RENDER_H,
                   0, PGL.RGBA, PGL.UNSIGNED_BYTE, null);
    pgl.texParameteri(PGL.TEXTURE_2D, PGL.TEXTURE_MIN_FILTER, PGL.LINEAR);
    pgl.texParameteri(PGL.TEXTURE_2D, PGL.TEXTURE_MAG_FILTER, PGL.LINEAR);
    pgl.texParameteri(PGL.TEXTURE_2D, PGL.TEXTURE_WRAP_S, PGL.REPEAT);
    pgl.texParameteri(PGL.TEXTURE_2D, PGL.TEXTURE_WRAP_T, PGL.REPEAT);
  }
  pgl.bindTexture(PGL.TEXTURE_2D, 0);

  // Generate FBO
  IntBuffer fb = IntBuffer.allocate(1);
  pgl.genFramebuffers(1, fb);
  fboId = fb.get(0);

  endPGL();

  // HUD cache uses JAVA2D — no GL context, CPU-only image
  hudCache  = createGraphics(290, 180, JAVA2D);
  hudDirty  = true;
  glReady   = true;
}


// ============================================================================
// DRAW
// ============================================================================

void draw() {
  if (!glReady) { initGL(); return; }

  int prevTex = 1 - currentTex;

  // --- 1. Bind our FBO, attach currentTex as render target ---
  PGL pgl = beginPGL();
  pgl.bindFramebuffer(PGL.FRAMEBUFFER, fboId);
  pgl.framebufferTexture2D(PGL.FRAMEBUFFER, PGL.COLOR_ATTACHMENT0,
                            PGL.TEXTURE_2D, texIds[currentTex], 0);
  pgl.viewport(0, 0, RENDER_W, RENDER_H);

  // Bind prev frame → unit 0 (u_feedback)
  pgl.activeTexture(PGL.TEXTURE0);
  pgl.bindTexture(PGL.TEXTURE_2D, texIds[prevTex]);

  // Bind delay → unit 1 (u_delay_feedback)
  pgl.activeTexture(PGL.TEXTURE1);
  pgl.bindTexture(PGL.TEXTURE_2D, texIds[2]);

  // Bind source image → unit 2 (u_gen_image), extract raw ID lazily
  if (sourceImage != null) {
    if (sourceImgTexId == 0) {
      Texture t = ((PGraphicsOpenGL)g).getTexture(sourceImage);
      if (t != null) sourceImgTexId = t.glName;
    }
    if (sourceImgTexId != 0) {
      pgl.activeTexture(PGL.TEXTURE2);
      pgl.bindTexture(PGL.TEXTURE_2D, sourceImgTexId);
    }
  }

  pgl.activeTexture(PGL.TEXTURE0);  // leave active unit at 0
  endPGL();

  // --- 2. Set shader uniforms (textures as unit indices, not PImage/PGraphics) ---
  feedbackShader.set("u_feedback",       0);
  feedbackShader.set("u_delay_feedback", 1);
  feedbackShader.set("u_gen_image",      2);

  feedbackShader.set("u_time",       millis() / 1000.0);
  feedbackShader.set("u_resolution", (float)RENDER_W, (float)RENDER_H);

  feedbackShader.set("u_gen_type",      gen_type);
  feedbackShader.set("u_gen_frequency", gen_frequency);
  feedbackShader.set("u_gen_size",      gen_size);
  feedbackShader.set("u_gen_pos_x",     gen_pos_x);
  feedbackShader.set("u_gen_pos_y",     gen_pos_y);
  feedbackShader.set("u_gen_softness",  gen_softness);
  feedbackShader.set("u_gen_hue",       gen_hue);
  feedbackShader.set("u_gen_intensity", gen_intensity);
  feedbackShader.set("u_gen_trigger",   gen_trigger);

  feedbackShader.set("u_fb_amount",      fb_amount);
  feedbackShader.set("u_fb_decay",       fb_decay);
  feedbackShader.set("u_fb_tap2_amount", fb_tap2_amount);
  feedbackShader.set("u_fb_tap2_offset", fb_tap2_offset);
  feedbackShader.set("u_fb_delay_amount", fb_delay_amount);

  feedbackShader.set("u_tf_scale",       tf_scale);
  feedbackShader.set("u_tf_rotation",    tf_rotation);
  feedbackShader.set("u_tf_translate_x", tf_translate_x);
  feedbackShader.set("u_tf_translate_y", tf_translate_y);
  feedbackShader.set("u_tf_mirror",      tf_mirror);
  feedbackShader.set("u_tf_displace",    tf_displace);

  feedbackShader.set("u_edge_type",         edge_type);
  feedbackShader.set("u_edge_mix",          edge_mix);
  feedbackShader.set("u_edge_threshold",    edge_threshold);
  feedbackShader.set("u_edge_colour_mode",  edge_colour_mode);
  feedbackShader.set("u_edge_pre_fb",       edge_pre_fb);

  feedbackShader.set("u_fx_posterize",        fx_posterize);
  feedbackShader.set("u_fx_posterize_smooth", fx_posterize_smooth);
  feedbackShader.set("u_fx_solarize",         fx_solarize);
  feedbackShader.set("u_fx_solarize_soft",    fx_solarize_soft);
  feedbackShader.set("u_fx_solarize_mode",    fx_solarize_mode);
  feedbackShader.set("u_fx_threshold",        fx_threshold);
  feedbackShader.set("u_fx_pixelate",         fx_pixelate);
  feedbackShader.set("u_fx_pre_fb",           fx_pre_fb);

  feedbackShader.set("u_col_hue_shift",  col_hue_shift);
  feedbackShader.set("u_col_saturation", col_saturation);
  feedbackShader.set("u_col_brightness", col_brightness);
  feedbackShader.set("u_col_contrast",   col_contrast);
  feedbackShader.set("u_col_rgb_sep",    col_rgb_sep);
  feedbackShader.set("u_col_invert",     col_invert);

  feedbackShader.set("u_blend_mode",    blend_mode);
  feedbackShader.set("u_post_blur",     post_blur);
  feedbackShader.set("u_post_noise",    post_noise);
  feedbackShader.set("u_post_soft_clip", post_soft_clip);
  feedbackShader.set("u_post_sharpen",  post_sharpen);

  // --- 3. Draw fullscreen quad into FBO ---
  // Viewport is RENDER_W×RENDER_H; rect covers full projection space → clips to FBO.
  shader(feedbackShader);
  rect(0, 0, width, height);
  resetShader();

  // --- 4. Unbind FBO → render back to screen ---
  pgl = beginPGL();
  pgl.bindFramebuffer(PGL.FRAMEBUFFER, 0);
  pgl.viewport(0, 0, width, height);
  pgl.activeTexture(PGL.TEXTURE0);
  pgl.bindTexture(PGL.TEXTURE_2D, texIds[currentTex]);
  endPGL();

  blitShader.set("u_tex",        0);
  blitShader.set("u_screen_res", (float)width, (float)height);
  shader(blitShader);
  rect(0, 0, width, height);
  resetShader();

  // --- 5. Swap ping-pong ---
  currentTex = 1 - currentTex;

  // --- 6. Update delay texture (pointer swap only — no pixel copy) ---
  frameCounter++;
  if (frameCounter % 8 == 0 && fb_delay_amount > 0.01) {
    int tmp = texIds[2]; texIds[2] = texIds[prevTex]; texIds[prevTex] = tmp;
  }

  // --- 7. HUD ---
  if (showHUD) {
    if (hudDirty) { renderHUDToCache(); hudDirty = false; }
    image(hudCache, 10, 10);
  }

  gen_trigger *= 0.9;
}


// ============================================================================
// HUD CACHE
// ============================================================================

void renderHUDToCache() {
  String[] genTypes   = {"Off","Voronoi","DomainWarp","Outlines","Stripes","Moire","Image"};
  String[] edgeTypes  = {"Off","Roberts","Gradient","Sobel","Temporal"};
  String[] blendTypes = {"Mix","Add","Multiply","Screen","Diff","Overlay"};

  hudCache.beginDraw();
  hudCache.background(0, 0, 0, 180);
  hudCache.fill(255);
  hudCache.noStroke();
  hudCache.textSize(11);
  int y = 15;
  int lh = 14;

  int gt = (int)gen_type;
  String gtName = (gt >= 0 && gt < genTypes.length) ? genTypes[gt] : "?";
  hudCache.text("Gen: " + gtName + " | Int: " + nf(gen_intensity,1,2) + " | Freq: " + nf(gen_frequency,1,1), 5, y); y += lh;
  hudCache.text("Feedback: " + nf(fb_amount,1,2) + " | Decay: " + nf(fb_decay,1,2), 5, y); y += lh;
  hudCache.text("Tap2: " + nf(fb_tap2_amount,1,2) + " | Delay: " + nf(fb_delay_amount,1,2) + " | Displace: " + nf(tf_displace,1,3), 5, y); y += lh;
  hudCache.text("Scale: " + nf(tf_scale,1,3) + " | Rot: " + nf(tf_rotation,1,3) + " | Mirror: " + (int)tf_mirror, 5, y); y += lh;
  hudCache.text("Edge: " + edgeTypes[(int)edge_type] + " | Mix: " + nf(edge_mix,1,2) + " | Thr: " + nf(edge_threshold,1,2), 5, y); y += lh;
  hudCache.text("Posterize: " + (int)fx_posterize + " | Solarize: " + nf(fx_solarize,1,2), 5, y); y += lh;
  hudCache.text("Hue: " + nf(col_hue_shift,1,3) + " | Sat: " + nf(col_saturation,1,2) + " | Blend: " + blendTypes[(int)blend_mode], 5, y); y += lh;
  hudCache.text("Blur: " + nf(post_blur,1,2) + " | Sharp: " + nf(post_sharpen,1,2) + " | Noise: " + nf(post_noise,1,3), 5, y); y += lh;
  hudCache.text("RGB sep: " + nf(col_rgb_sep,1,3) + " | Contrast: " + nf(col_contrast,1,2), 5, y); y += lh;
  hudCache.text("Render: " + RENDER_W + "x" + RENDER_H + " | FPS: " + (int)frameRate, 5, y); y += lh;
  if (gt == 6 && imageFiles.size() > 0) {
    hudCache.text("Img: [" + currentImageIndex + "] " + imageFiles.get(currentImageIndex), 5, y);
  }
  hudCache.endDraw();
}


// ============================================================================
// FULLSCREEN
// ============================================================================

void toggleFullScreen() {
  isFullScreen = !isFullScreen;
  if (isFullScreen) {
    surface.setLocation(0, 0);
    surface.setSize(displayWidth, displayHeight);
  } else {
    surface.setSize(WINDOW_W, WINDOW_H);
    surface.setLocation((displayWidth - WINDOW_W) / 2, (displayHeight - WINDOW_H) / 2);
  }
}


// ============================================================================
// IMAGE LIBRARY
// ============================================================================

void loadImageLibrary() {
  File imgDir = new File(sketchPath("FB Images"));
  if (!imgDir.exists()) { println("FB Images folder not found."); return; }
  String[] files = imgDir.list();
  if (files == null) return;
  imageFiles = new ArrayList<String>();
  for (String f : files) {
    String lower = f.toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") ||
        lower.endsWith(".png") || lower.endsWith(".gif") || lower.endsWith(".tga")) {
      imageFiles.add(f);
    }
  }
  java.util.Collections.sort(imageFiles);
  println("Image library: " + imageFiles.size() + " images loaded.");
}

void loadImageByIndex(int idx) {
  if (imageFiles.size() == 0) return;
  currentImageIndex = ((idx % imageFiles.size()) + imageFiles.size()) % imageFiles.size();
  String path = sketchPath("FB Images/" + imageFiles.get(currentImageIndex));
  sourceImage    = loadImage(path);
  sourceImage.resize(RENDER_W, RENDER_H);
  sourceImgTexId = 0;  // invalidate cached GL ID — re-extracted in draw()
  println("Image: [" + currentImageIndex + "] " + imageFiles.get(currentImageIndex));
}


// ============================================================================
// CLEAR BUFFERS
// ============================================================================

void clearBuffers() {
  if (!glReady) { frameCounter = 0; return; }
  PGL pgl = beginPGL();
  pgl.bindFramebuffer(PGL.FRAMEBUFFER, fboId);
  pgl.clearColor(0, 0, 0, 1);
  for (int i = 0; i < 3; i++) {
    pgl.framebufferTexture2D(PGL.FRAMEBUFFER, PGL.COLOR_ATTACHMENT0,
                              PGL.TEXTURE_2D, texIds[i], 0);
    pgl.clear(PGL.COLOR_BUFFER_BIT);
  }
  pgl.bindFramebuffer(PGL.FRAMEBUFFER, 0);
  endPGL();
  frameCounter = 0;
}


// ============================================================================
// KEYBOARD CONTROLS
// ============================================================================

void keyPressed() {
  boolean shifted = (key >= 'A' && key <= 'Z') || key == '!' || key == '@' || key == '#'
                    || key == '$' || key == '%' || key == '^' || key == '<' || key == '>'
                    || key == ':' || key == '"';

  // Presets
  if (key == '!') { applyPreset("tunnel");       return; }
  if (key == '@') { applyPreset("psychedelic");  return; }
  if (key == '#') { applyPreset("glitch");       return; }
  if (key == '$') { applyPreset("minimal");      return; }
  if (key == '%') { applyPreset("kaleidoscope"); return; }
  if (key == '^') { applyPreset("vhs");          return; }

  // Utility
  if (key == '0')         { resetParameters(); return; }
  if (keyCode == BACKSPACE) { clearBuffers();  return; }
  if (key == ' ')         { gen_trigger = 1.0; return; }
  if (key == TAB)         { showHUD = !showHUD; return; }
  if (key == '\\')        { toggleFullScreen(); return; }

  // Generator types (0-6)
  if (key == '1') { gen_type = 1; hudDirty = true; return; }
  if (key == '2' && !shifted) { gen_type = 2; hudDirty = true; return; }
  if (key == '3' && !shifted) { gen_type = 3; hudDirty = true; return; }
  if (key == '4' && !shifted) { gen_type = 4; hudDirty = true; return; }
  if (key == '5' && !shifted) { gen_type = 5; hudDirty = true; return; }  // Moire
  if (key == '6' && !shifted) { gen_type = 6; hudDirty = true; return; }  // Image

  // Generator intensity
  if (key == '+' || key == '=') { gen_intensity = constrain(gen_intensity + 0.05, 0, 1); hudDirty = true; return; }
  if (key == '-' || key == '_') { gen_intensity = constrain(gen_intensity - 0.05, 0, 1); hudDirty = true; return; }

  // Edge threshold
  if (key == '7') { edge_threshold = constrain(edge_threshold + 0.02, 0.0, 1.0); hudDirty = true; return; }
  if (key == '8') { edge_threshold = constrain(edge_threshold - 0.02, 0.0, 1.0); hudDirty = true; return; }

  // Edge colour mode
  if (key == '9') { edge_colour_mode = (edge_colour_mode + 1) % 3; hudDirty = true; return; }

  // Generator hue
  if (key == '[') { gen_hue = (gen_hue - 0.02 + 1.0) % 1.0; hudDirty = true; return; }
  if (key == ']') { gen_hue = (gen_hue + 0.02) % 1.0; hudDirty = true; return; }

  // Generator softness
  if (key == ';')  { gen_softness = constrain(gen_softness + 0.02, 0.0, 1.0); hudDirty = true; return; }
  if (key == '\'') { gen_softness = constrain(gen_softness - 0.02, 0.0, 1.0); hudDirty = true; return; }

  // Generator position Y
  if (key == ',') { gen_pos_y = constrain(gen_pos_y - 0.02, -1.0, 1.0); hudDirty = true; return; }
  if (key == '.') { gen_pos_y = constrain(gen_pos_y + 0.02, -1.0, 1.0); hudDirty = true; return; }

  // Arrow keys: cycle images (gen type 6)
  if (keyCode == LEFT)  { loadImageByIndex(currentImageIndex - 1); return; }
  if (keyCode == RIGHT) { loadImageByIndex(currentImageIndex + 1); return; }

  // SHIFTED keys
  if (shifted) {
    if (key == 'Q') { fb_tap2_amount = constrain(fb_tap2_amount + 0.02, 0.0, 1.0); hudDirty = true; return; }
    if (key == 'W') { fb_tap2_amount = constrain(fb_tap2_amount - 0.02, 0.0, 1.0); hudDirty = true; return; }
    if (key == 'E') { fb_tap2_offset = constrain(fb_tap2_offset + 0.005, -0.1, 0.1); hudDirty = true; return; }
    if (key == 'R') { fb_tap2_offset = constrain(fb_tap2_offset - 0.005, -0.1, 0.1); hudDirty = true; return; }
    if (key == 'T') { fb_delay_amount = constrain(fb_delay_amount + 0.02, 0.0, 1.0); hudDirty = true; return; }
    if (key == 'Y') { tf_displace = constrain(tf_displace + 0.002, 0.0, 0.1); hudDirty = true; return; }
    if (key == 'S') { col_saturation = constrain(col_saturation + 0.05, 0.0, 2.0); hudDirty = true; return; }
    if (key == 'D') { col_saturation = constrain(col_saturation - 0.05, 0.0, 2.0); hudDirty = true; return; }
    if (key == 'F') { col_brightness = constrain(col_brightness + 0.02, -0.5, 0.5); hudDirty = true; return; }
    if (key == 'G') { col_brightness = constrain(col_brightness - 0.02, -0.5, 0.5); hudDirty = true; return; }
    if (key == 'H') { col_contrast = constrain(col_contrast + 0.05, 0.5, 2.0); hudDirty = true; return; }
    if (key == 'J') { col_contrast = constrain(col_contrast - 0.05, 0.5, 2.0); hudDirty = true; return; }
    if (key == 'K') { col_rgb_sep = constrain(col_rgb_sep + 0.001, 0.0, 0.05); hudDirty = true; return; }
    if (key == 'L') { col_rgb_sep = constrain(col_rgb_sep - 0.001, 0.0, 0.05); hudDirty = true; return; }
    if (key == ':') { col_invert = constrain(col_invert + 0.05, 0.0, 1.0); hudDirty = true; return; }
    if (key == '"') { col_invert = constrain(col_invert - 0.05, 0.0, 1.0); hudDirty = true; return; }
    if (key == 'B') { blend_mode = (blend_mode + 1) % 6; hudDirty = true; return; }
    if (key == 'N') { post_blur = constrain(post_blur + 0.02, 0.0, 1.0); hudDirty = true; return; }
    if (key == 'M') { post_noise = constrain(post_noise + 0.002, 0.0, 0.1); hudDirty = true; return; }
    if (key == '<') { post_soft_clip = constrain(post_soft_clip + 0.02, 0.0, 1.0); hudDirty = true; return; }
    if (key == '>') { post_sharpen = constrain(post_sharpen + 0.02, 0.0, 1.0); hudDirty = true; return; }
    if (key == 'Z') { fx_threshold = constrain(fx_threshold + 0.02, 0.0, 1.0); hudDirty = true; return; }
    if (key == 'X') { fx_threshold = constrain(fx_threshold - 0.02, 0.0, 1.0); hudDirty = true; return; }
    if (key == 'C') { fx_pixelate = constrain(fx_pixelate + 1.0, 1.0, 64.0); hudDirty = true; return; }
    if (key == 'V') { fx_pixelate = constrain(fx_pixelate - 1.0, 1.0, 64.0); hudDirty = true; return; }
    if (key == 'A') { fx_pre_fb = fx_pre_fb < 0.5 ? 1.0 : 0.0; hudDirty = true; return; }
    return;
  }

  // Unshifted lowercase
  if (key == 'q') { fb_amount = constrain(fb_amount + 0.02, 0, 1); hudDirty = true; return; }
  if (key == 'a') { fb_amount = constrain(fb_amount - 0.02, 0, 1); hudDirty = true; return; }
  if (key == 'w') { fb_decay = constrain(fb_decay + 0.01, 0, 1); hudDirty = true; return; }
  if (key == 's') { fb_decay = constrain(fb_decay - 0.01, 0, 1); hudDirty = true; return; }
  if (key == 'e') { tf_scale = constrain(tf_scale + 0.005, 0.9, 1.1); hudDirty = true; return; }
  if (key == 'd') { tf_scale = constrain(tf_scale - 0.005, 0.9, 1.1); hudDirty = true; return; }
  if (key == 'r') { tf_rotation = constrain(tf_rotation + 0.005, -0.1, 0.1); hudDirty = true; return; }
  if (key == 'f') { tf_rotation = constrain(tf_rotation - 0.005, -0.1, 0.1); hudDirty = true; return; }
  if (key == 't') { col_hue_shift = (col_hue_shift + 0.02) % 1.0; hudDirty = true; return; }
  if (key == 'g') { col_hue_shift = (col_hue_shift - 0.02 + 1.0) % 1.0; hudDirty = true; return; }
  if (key == 'y') { edge_type = (edge_type + 1) % 5; hudDirty = true; return; }
  if (key == 'h') { edge_type = (edge_type - 1 + 5) % 5; hudDirty = true; return; }
  if (key == 'u') { edge_mix = constrain(edge_mix + 0.05, 0, 1); hudDirty = true; return; }
  if (key == 'j') { edge_mix = constrain(edge_mix - 0.05, 0, 1); hudDirty = true; return; }
  if (key == 'i') { fx_posterize = constrain(fx_posterize + 1, 0, 32); hudDirty = true; return; }
  if (key == 'k') { fx_posterize = constrain(fx_posterize - 1, 0, 32); hudDirty = true; return; }
  if (key == 'o') { fx_solarize = constrain(fx_solarize + 0.05, 0, 1); hudDirty = true; return; }
  if (key == 'l') { fx_solarize = constrain(fx_solarize - 0.05, 0, 1); hudDirty = true; return; }
  if (key == 'p') { edge_pre_fb = edge_pre_fb < 0.5 ? 1.0 : 0.0; hudDirty = true; return; }
  if (key == 'm') { tf_mirror = (tf_mirror + 1) % 5; hudDirty = true; return; }
  if (key == 'z') { gen_frequency = constrain(gen_frequency - 0.1, 0.1, 20.0); hudDirty = true; return; }
  if (key == 'x') { gen_frequency = constrain(gen_frequency + 0.1, 0.1, 20.0); hudDirty = true; return; }
  if (key == 'c') { gen_size = constrain(gen_size - 0.02, 0.0, 1.0); hudDirty = true; return; }
  if (key == 'v') { gen_size = constrain(gen_size + 0.02, 0.0, 1.0); hudDirty = true; return; }
  if (key == 'b') { gen_pos_x = constrain(gen_pos_x - 0.02, -1.0, 1.0); hudDirty = true; return; }
  if (key == 'n') { gen_pos_x = constrain(gen_pos_x + 0.02, -1.0, 1.0); hudDirty = true; return; }
}


// ============================================================================
// RESET / CLEAR / PRESETS
// ============================================================================

void resetParameters() {
  gen_type = 1; gen_frequency = 1.0; gen_size = 0.3;
  gen_pos_x = 0.0; gen_pos_y = 0.0; gen_softness = 0.5;
  gen_hue = 0.0; gen_intensity = 0.5; gen_trigger = 0.0;

  fb_amount = 0.9; fb_decay = 0.98;
  fb_tap2_amount = 0.0; fb_tap2_offset = 0.0; fb_delay_amount = 0.0;

  tf_scale = 1.01; tf_rotation = 0.01;
  tf_translate_x = 0.0; tf_translate_y = 0.0;
  tf_mirror = 0; tf_displace = 0.0;

  edge_type = 0; edge_mix = 0.5; edge_threshold = 0.1;
  edge_colour_mode = 0; edge_pre_fb = 0;

  fx_posterize = 0; fx_posterize_smooth = 0.0;
  fx_solarize = 0.0; fx_solarize_soft = 0.5; fx_solarize_mode = 0;
  fx_threshold = 0.0; fx_pixelate = 1.0; fx_pre_fb = 0;

  col_hue_shift = 0.0; col_saturation = 1.0; col_brightness = 0.0;
  col_contrast = 1.0; col_rgb_sep = 0.0; col_invert = 0.0;

  blend_mode = 0;
  post_blur = 0.0; post_noise = 0.0; post_soft_clip = 0.0; post_sharpen = 0.0;

  clearBuffers();
  hudDirty = true;
}


void applyPreset(String name) {
  resetParameters();

  if (name.equals("tunnel")) {
    gen_type = 1; gen_intensity = 0.3;
    fb_amount = 0.95; fb_decay = 0.98;
    tf_scale = 1.02; tf_rotation = 0.02;
    col_hue_shift = 0.002;

  } else if (name.equals("psychedelic")) {
    gen_type = 2; gen_intensity = 0.2; gen_size = 0.4; gen_softness = 0.6;
    fb_amount = 0.9; fb_decay = 0.95;
    tf_rotation = 0.03;
    fx_solarize = 0.5; fx_solarize_mode = 1;
    col_hue_shift = 0.01; col_saturation = 1.5;

  } else if (name.equals("glitch")) {
    gen_type = 5;  // Moire (was type 6 before reaction-diff removal)
    gen_intensity = 0.4;
    fb_amount = 0.85; fb_decay = 0.9;
    edge_type = 2; edge_mix = 0.7; edge_pre_fb = 1;
    col_rgb_sep = 0.02;
    fx_posterize = 6;
    tf_displace = 0.02;
    fb_tap2_amount = 0.3; fb_tap2_offset = 0.015;

  } else if (name.equals("minimal")) {
    gen_type = 3;  // Outlined shapes (reaction-diff removed)
    gen_intensity = 0.5;
    fb_amount = 0.8; fb_decay = 0.7;
    tf_scale = 1.0; tf_rotation = 0.0;
    fx_posterize = 8;

  } else if (name.equals("kaleidoscope")) {
    gen_type = 4; gen_intensity = 0.4;
    fb_amount = 0.92; fb_decay = 0.96;
    tf_scale = 1.015; tf_rotation = 0.015; tf_mirror = 4;
    col_hue_shift = 0.005; col_saturation = 1.3;

  } else if (name.equals("vhs")) {
    gen_type = 1; gen_intensity = 0.4;
    fb_amount = 0.88; fb_decay = 0.92;
    tf_scale = 1.005; tf_translate_y = 0.002;
    col_rgb_sep = 0.015; col_saturation = 0.8; col_contrast = 1.2;
    post_noise = 0.03; post_blur = 0.2;
  }

  hudDirty = true;
}


// ============================================================================
// MIDI CC HANDLER
// ============================================================================

void handleControllerChange(int number, float norm) {
  switch(number) {
    // Generator (CC 1: 7 types, indices 0-6)
    case 1:  gen_type      = (int)(norm * 6); hudDirty = true; break;
    case 2:  gen_frequency = 0.1 + norm * 19.9; hudDirty = true; break;
    case 3:  gen_size      = norm; hudDirty = true; break;
    case 4:  gen_pos_x     = norm * 2.0 - 1.0; hudDirty = true; break;
    case 5:  gen_pos_y     = norm * 2.0 - 1.0; hudDirty = true; break;
    case 6:  gen_softness  = norm; hudDirty = true; break;
    case 7:  gen_hue       = norm; hudDirty = true; break;
    case 8:  gen_intensity = norm; hudDirty = true; break;

    // Feedback
    case 10: fb_amount     = norm; hudDirty = true; break;
    case 11: fb_decay      = norm; hudDirty = true; break;

    // Transform
    case 12: tf_scale      = 0.9 + norm * 0.2; hudDirty = true; break;
    case 13: tf_rotation   = (norm - 0.5) * 0.2; hudDirty = true; break;
    case 14: tf_translate_x = (norm - 0.5) * 0.2; hudDirty = true; break;
    case 15: tf_translate_y = (norm - 0.5) * 0.2; hudDirty = true; break;
    case 16: tf_mirror     = (int)(norm * 4); hudDirty = true; break;

    // Edge detection
    case 17: edge_type        = (int)(norm * 4); hudDirty = true; break;
    case 18: edge_mix         = norm; hudDirty = true; break;
    case 19: edge_threshold   = norm; hudDirty = true; break;
    case 20: edge_colour_mode = (int)(norm * 2); hudDirty = true; break;
    case 21: edge_pre_fb      = norm > 0.5 ? 1.0 : 0.0; hudDirty = true; break;

    // Effects
    case 22: fx_posterize        = norm * 32.0; hudDirty = true; break;
    case 23: fx_posterize_smooth = norm; hudDirty = true; break;
    case 24: fx_solarize         = norm; hudDirty = true; break;
    case 25: fx_solarize_soft    = norm; hudDirty = true; break;
    case 26: fx_solarize_mode    = (int)(norm * 2); hudDirty = true; break;
    case 27: fx_threshold        = norm; hudDirty = true; break;
    case 28: fx_pixelate         = 1.0 + norm * 63.0; hudDirty = true; break;
    case 29: fx_pre_fb           = norm > 0.5 ? 1.0 : 0.0; hudDirty = true; break;

    // Colour
    case 30: col_hue_shift  = norm; hudDirty = true; break;
    case 31: col_saturation = norm * 2.0; hudDirty = true; break;
    case 32: col_brightness = norm - 0.5; hudDirty = true; break;
    case 33: col_contrast   = 0.5 + norm * 1.5; hudDirty = true; break;
    case 34: col_rgb_sep    = norm * 0.05; hudDirty = true; break;
    case 35: col_invert     = norm; hudDirty = true; break;

    // Blend
    case 36: blend_mode = (int)(norm * 5); hudDirty = true; break;

    // Post
    case 37: post_blur      = norm; hudDirty = true; break;
    case 38: post_noise     = norm * 0.1; hudDirty = true; break;
    case 39: post_soft_clip = norm; hudDirty = true; break;
    case 40: post_sharpen   = norm; hudDirty = true; break;

    // Extended
    case 41: tf_displace     = norm * 0.1; hudDirty = true; break;
    case 42: fb_tap2_amount  = norm; hudDirty = true; break;
    case 43: fb_tap2_offset  = (norm - 0.5) * 0.2; hudDirty = true; break;
    case 44: fb_delay_amount = norm; hudDirty = true; break;
  }
}
