// ============================================================================
// PASSTHROUGH VERTEX SHADER
// ============================================================================
// Simple vertex shader for fullscreen quad rendering.
// Used with feedback.frag for analog video feedback simulation.
// ============================================================================

#ifdef GL_ES
precision mediump float;
#endif

// Processing P2D/P3D provide these built-in attributes/uniforms
attribute vec4 position;
uniform mat4 transform;

void main() {
    // Use Processing's transform matrix so the fullscreen rect()
    // actually covers the viewport in clip space.
    gl_Position = transform * position;
}
