// Simple blit shader — samples raw GL texture via unit 0 and upscales to screen.
#ifdef GL_ES
precision mediump float;
#endif

uniform sampler2D u_tex;
uniform vec2 u_screen_res;

void main() {
    vec2 uv = gl_FragCoord.xy / u_screen_res;
    gl_FragColor = texture2D(u_tex, uv);
}
