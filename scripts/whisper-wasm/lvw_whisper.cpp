// Small whisper.cpp binding for the LvW web UI (MIT). Runs inside a Web Worker, so the
// synchronous calls never block the page. The model is read from a mounted File (WORKERFS).
#include "whisper.h"

#include <emscripten/bind.h>

#include <string>
#include <thread>
#include <vector>

static whisper_context * g_ctx = nullptr;

static bool load(const std::string & path) {
    if (g_ctx) {
        whisper_free(g_ctx);
        g_ctx = nullptr;
    }
    whisper_context_params cparams = whisper_context_default_params();
    cparams.use_gpu = false;
    g_ctx = whisper_init_from_file_with_params(path.c_str(), cparams);
    return g_ctx != nullptr;
}

static void unload() {
    if (g_ctx) whisper_free(g_ctx);
    g_ctx = nullptr;
}

// audio: 16 kHz mono Float32Array. lang: "auto", "en", "nl", ... Returns the text, or "" on failure.
static std::string transcribe(const emscripten::val & audio, const std::string & lang, int nthreads, bool translate) {
    if (!g_ctx) return "";
    std::vector<float> pcm = emscripten::convertJSArrayToNumberVector<float>(audio);
    whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    p.print_realtime = false;
    p.print_progress = false;
    p.print_timestamps = false;
    p.print_special = false;
    p.translate = translate;
    p.language = whisper_is_multilingual(g_ctx) ? lang.c_str() : "en";
    p.detect_language = false;
    p.n_threads = nthreads > 0 ? nthreads : 4;
    if (whisper_full(g_ctx, p, pcm.data(), (int) pcm.size()) != 0) return "";
    std::string out;
    const int n = whisper_full_n_segments(g_ctx);
    for (int i = 0; i < n; ++i) out += whisper_full_get_segment_text(g_ctx, i);
    return out;
}

static std::string language() {
    if (!g_ctx) return "";
    return whisper_lang_str(whisper_full_lang_id(g_ctx));
}

EMSCRIPTEN_BINDINGS(lvw_whisper) {
    emscripten::function("load", &load);
    emscripten::function("unload", &unload);
    emscripten::function("transcribe", &transcribe);
    emscripten::function("language", &language);
    emscripten::function("systemInfo", emscripten::optional_override([]() { return std::string(whisper_print_system_info()); }));
}
