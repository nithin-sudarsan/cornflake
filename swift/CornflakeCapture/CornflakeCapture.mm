// CornflakeCapture.mm
// N-API addon: system audio via ScreenCaptureKit, mic via AVAudioEngine.
// Both streams output as 16 kHz mono 16-bit PCM WAV temp files.
//
// Exported:
//   startCapture(cb: (err: string|null) => void): void
//   stopCapture (cb: (err: string|null, result: {micPath,systemAudioPath}|null) => void): void

#import <Foundation/Foundation.h>
#import <ScreenCaptureKit/ScreenCaptureKit.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreGraphics/CoreGraphics.h>
#include <napi.h>
#include <string>
#include <atomic>
#include <mutex>
#include <cstdio>
#include <cstdint>

// ─── WAV helpers ─────────────────────────────────────────────────────────────

static constexpr uint32_t kSampleRate = 16000;
static constexpr uint16_t kChannels   = 1;

static inline int16_t f32ToI16(float v) {
    if (v >  1.0f) v =  1.0f;
    if (v < -1.0f) v = -1.0f;
    return static_cast<int16_t>(v * 32767.0f);
}

// Write 44-byte WAV header at the current file position.
static void writeWavHeader(FILE* f, uint32_t numSamples) {
    uint32_t dataSize   = numSamples * kChannels * 2;
    uint32_t chunkSize  = 36 + dataSize;
    uint16_t audioFmt   = 1;
    uint32_t byteRate   = kSampleRate * kChannels * 2;
    uint16_t blockAlign = kChannels * 2;
    uint16_t bitsPerSample = 16;
    uint32_t fmtSize    = 16;

    fseek(f, 0, SEEK_SET);
    fwrite("RIFF",          1, 4, f); fwrite(&chunkSize,    4, 1, f);
    fwrite("WAVE",          1, 4, f);
    fwrite("fmt ",          1, 4, f); fwrite(&fmtSize,      4, 1, f);
    fwrite(&audioFmt,       2, 1, f);
    uint16_t ch = kChannels;
    fwrite(&ch,             2, 1, f);
    uint32_t sr = kSampleRate;
    fwrite(&sr,             4, 1, f); fwrite(&byteRate,     4, 1, f);
    fwrite(&blockAlign,     2, 1, f); fwrite(&bitsPerSample,2, 1, f);
    fwrite("data",          1, 4, f); fwrite(&dataSize,     4, 1, f);
}

// Thread-safe PCM file accumulator. Opens with a 44-byte placeholder header;
// finalises the real header when close() is called.
struct PcmFile {
    FILE*    fp         = nullptr;
    uint32_t numSamples = 0;
    std::mutex mtx;

    bool open(const std::string& path) {
        std::lock_guard<std::mutex> lk(mtx);
        fp = fopen(path.c_str(), "wb");
        if (!fp) return false;
        uint8_t hdr[44] = {};
        fwrite(hdr, 1, 44, fp);
        numSamples = 0;
        return true;
    }

    void writeSamples(const float* buf, size_t n) {
        std::lock_guard<std::mutex> lk(mtx);
        if (!fp) return;
        for (size_t i = 0; i < n; ++i) {
            int16_t s = f32ToI16(buf[i]);
            fwrite(&s, 2, 1, fp);
        }
        numSamples += static_cast<uint32_t>(n);
    }

    void finalise() {
        std::lock_guard<std::mutex> lk(mtx);
        if (!fp) return;
        writeWavHeader(fp, numSamples);
        fclose(fp);
        fp = nullptr;
    }
};

// ─── Global capture state ────────────────────────────────────────────────────

static SCStream*  __strong g_stream  API_AVAILABLE(macos(13.0)) = nil;
static id         __strong g_handler = nil;  // CornflakeStreamHandler* — kept alive by global
static AVAudioEngine*      g_engine  = nil;
static std::atomic<bool>         g_capturing    { false };
static std::string               g_sysPath;
static std::string               g_micPath;
static PcmFile                   g_sysFile;
static PcmFile                   g_micFile;

// Shared result slots written before invoking the TSFN callback.
static std::string g_startError;
static std::string g_stopError;
static std::string g_stopSysPath;
static std::string g_stopMicPath;

static Napi::ThreadSafeFunction g_startTsfn;
static Napi::ThreadSafeFunction g_stopTsfn;
static std::atomic<bool>        g_startTsfnLive { false };
static std::atomic<bool>        g_stopTsfnLive  { false };

static std::string nsStringToStd(NSString* s) {
    return s ? std::string([s UTF8String]) : std::string("");
}

static void logNSError(NSString* context, NSError* error) {
    if (!error) {
        NSLog(@"[CornflakeCapture] %@: no NSError", context);
        return;
    }
    NSLog(@"[CornflakeCapture] %@: domain=%@ code=%ld localized=%@ userInfo=%@",
          context,
          error.domain,
          (long)error.code,
          error.localizedDescription,
          error.userInfo);
}

static std::string screenCaptureErrorMessage(NSError* error, const char* fallback) {
    if (!error) return std::string(fallback);

    std::string localized = nsStringToStd(error.localizedDescription);
    if ([error.domain isEqualToString:SCStreamErrorDomain] &&
        error.code == SCStreamErrorUserDeclined) {
        return std::string("SCSTREAM_USER_DECLINED:") + localized;
    }

    std::string msg = "SCSTREAM_ERROR:";
    msg += nsStringToStd(error.domain);
    msg += ":";
    msg += std::to_string((long)error.code);
    msg += ":";
    msg += localized;
    return msg;
}

static void cleanupAfterStartFailure() {
    if (g_engine) {
        @try {
            [g_engine.inputNode removeTapOnBus:0];
        } @catch (NSException* ex) {
            NSLog(@"[CornflakeCapture] cleanup removeTap exception: %@", ex.reason);
        }
        [g_engine stop];
        g_engine = nil;
    }

    g_handler = nil;
    g_stream = nil;
    g_capturing.store(false);
    g_micFile.finalise();
    g_sysFile.finalise();
}

// ─── TSFN call-JS callbacks (run on Node thread) ─────────────────────────────

// BlockingCall(data, callback) — callback signature is (Env, Function, DataType*)
static void OnStartCallJs(Napi::Env env, Napi::Function jsCb, void* /*data*/) {
    if (g_startError.empty()) {
        jsCb.Call({ env.Null() });
    } else {
        jsCb.Call({ Napi::String::New(env, g_startError) });
    }
}

static void OnStopCallJs(Napi::Env env, Napi::Function jsCb, void* /*data*/) {
    if (!g_stopError.empty()) {
        jsCb.Call({ Napi::String::New(env, g_stopError), env.Null() });
    } else {
        Napi::Object res = Napi::Object::New(env);
        res.Set("systemAudioPath", Napi::String::New(env, g_stopSysPath));
        res.Set("micPath",         Napi::String::New(env, g_stopMicPath));
        jsCb.Call({ env.Null(), res });
    }
}

static void fireStart(const std::string& err) {
    if (!g_startTsfnLive.exchange(false)) return;
    g_startError = err;
    g_startTsfn.BlockingCall(static_cast<void*>(nullptr), OnStartCallJs);
    g_startTsfn.Release();
}

static void fireStop(const std::string& err, const std::string& sys, const std::string& mic) {
    if (!g_stopTsfnLive.exchange(false)) return;
    g_stopError   = err;
    g_stopSysPath = sys;
    g_stopMicPath = mic;
    g_stopTsfn.BlockingCall(static_cast<void*>(nullptr), OnStopCallJs);
    g_stopTsfn.Release();
}

// ─── SCStream audio delegate ─────────────────────────────────────────────────

API_AVAILABLE(macos(13.0))
@interface CornflakeStreamHandler : NSObject <SCStreamOutput, SCStreamDelegate>
@end

@implementation CornflakeStreamHandler

- (void)stream:(SCStream*)stream
    didOutputSampleBuffer:(CMSampleBufferRef)sampleBuffer
                   ofType:(SCStreamOutputType)type {
    if (type != SCStreamOutputTypeAudio) return;  // discard video frames
    if (!g_capturing.load()) return;

    AudioBufferList abl;
    CMBlockBufferRef blockBuf = NULL;
    OSStatus err = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
        sampleBuffer, NULL, &abl, sizeof(abl),
        kCFAllocatorDefault, kCFAllocatorDefault,
        kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment, &blockBuf);
    if (err != noErr) return;

    for (UInt32 i = 0; i < abl.mNumberBuffers; ++i) {
        const float* samples = static_cast<const float*>(abl.mBuffers[i].mData);
        size_t n = abl.mBuffers[i].mDataByteSize / sizeof(float);
        g_sysFile.writeSamples(samples, n);
    }
    if (blockBuf) CFRelease(blockBuf);
}

- (void)stream:(SCStream*)stream didStopWithError:(NSError*)error {
    if (error) logNSError(@"stream didStopWithError", error);
    g_capturing.store(false);
}

@end

// ─── startCapture ────────────────────────────────────────────────────────────

static Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "startCapture(callback) expected").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (g_capturing.load()) {
        Napi::Error::New(env, "Already capturing").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Create temp WAV file paths
    NSString* tmp  = NSTemporaryDirectory();
    NSString* uuid = [[NSUUID UUID] UUIDString];
    g_sysPath = [[tmp stringByAppendingPathComponent:
                  [NSString stringWithFormat:@"cf_sys_%@.wav", uuid]] UTF8String];
    g_micPath = [[tmp stringByAppendingPathComponent:
                  [NSString stringWithFormat:@"cf_mic_%@.wav", uuid]] UTF8String];

    if (!g_sysFile.open(g_sysPath) || !g_micFile.open(g_micPath)) {
        Napi::Error::New(env, "Failed to create temp audio files").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Set up TSFN before going async
    g_startTsfn = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "startCapture", 0, 1);
    g_startTsfnLive.store(true);

    // ── Mic: AVAudioEngine ────────────────────────────────────────────────────
    // The tap must use the input node's hardware output format.
    // Resampling to kSampleRate is done inside the tap via AVAudioConverter.
    g_engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* inputNode = g_engine.inputNode;
    AVAudioFormat* hwFmt = [inputNode outputFormatForBus:0];

    AVAudioFormat* targetFmt = [[AVAudioFormat alloc]
        initWithCommonFormat:AVAudioPCMFormatFloat32
                  sampleRate:kSampleRate
                    channels:kChannels
                 interleaved:NO];

    __block AVAudioConverter* micConverter =
        [[AVAudioConverter alloc] initFromFormat:hwFmt toFormat:targetFmt];

    [inputNode installTapOnBus:0 bufferSize:4096 format:hwFmt
                         block:^(AVAudioPCMBuffer* hwBuf, AVAudioTime*) {
        if (!g_capturing.load()) return;

        double ratio = targetFmt.sampleRate / hwFmt.sampleRate;
        AVAudioFrameCount outFrames =
            static_cast<AVAudioFrameCount>(ceil(hwBuf.frameLength * ratio)) + 8;
        AVAudioPCMBuffer* outBuf =
            [[AVAudioPCMBuffer alloc] initWithPCMFormat:targetFmt frameCapacity:outFrames];

        __block BOOL inputConsumed = NO;
        NSError* cvtErr = nil;
        [micConverter convertToBuffer:outBuf error:&cvtErr
             withInputFromBlock:^AVAudioBuffer*(AVAudioPacketCount /*n*/,
                                                 AVAudioConverterInputStatus* status) {
                 if (!inputConsumed) {
                     *status = AVAudioConverterInputStatus_HaveData;
                     inputConsumed = YES;
                     return hwBuf;
                 }
                 *status = AVAudioConverterInputStatus_NoDataNow;
                 return nil;
             }];

        if (!cvtErr && outBuf.frameLength > 0 && outBuf.floatChannelData)
            g_micFile.writeSamples(outBuf.floatChannelData[0], outBuf.frameLength);
    }];

    NSError* engineErr = nil;
    [g_engine startAndReturnError:&engineErr];
    if (engineErr) {
        NSLog(@"[CornflakeCapture] AVAudioEngine error: %@", engineErr.localizedDescription);
        // Non-fatal for dev — mic permission may not be granted yet.
    }

    // ── System audio: SCStream ────────────────────────────────────────────────
    if (@available(macOS 13.0, *)) {
        // Use the documented CoreGraphics TCC API as the gate before touching
        // SCStream. CGPreflightScreenCaptureAccess re-checks the TCC database
        // for the running app's code signature; CGRequestScreenCaptureAccess
        // triggers the system consent dialog if the grant hasn't been
        // recorded yet. SCStream's own implicit prompt is unreliable for
        // ad-hoc-signed apps — going through CG first gives us a much clearer
        // signal and forces macOS to refresh its in-process cache.
        bool cgPre  = CGPreflightScreenCaptureAccess();
        NSLog(@"[CornflakeCapture] CGPreflightScreenCaptureAccess (pre) = %d", cgPre);
        if (!cgPre) {
            // Fire the system dialog (no-op if previously denied).
            bool cgReq = CGRequestScreenCaptureAccess();
            NSLog(@"[CornflakeCapture] CGRequestScreenCaptureAccess = %d", cgReq);
            // Re-check after the request — note: if this is the first time we've
            // asked, the dialog is asynchronous and preflight may still be false
            // for a few hundred ms. We let the SCShareableContent retry handle
            // that race; if cgPost is still false we fall through to SCStream
            // which will return SCStreamErrorUserDeclined and we surface the
            // proper screen_denied UI.
            bool cgPost = CGPreflightScreenCaptureAccess();
            NSLog(@"[CornflakeCapture] CGPreflightScreenCaptureAccess (post) = %d", cgPost);
        }

        // SCShareableContent has a known race after a fresh Screen Recording
        // TCC grant: the first call back can return a stale "not authorized"
        // error even though the grant is now active. Retry once after a brief
        // delay before classifying the failure for the JS layer.
        __block int sccAttempt = 0;
        __block void (^__weak weakSccAttempt)(void) = nil;
        void (^sccAttemptBlock)(void) = ^{
            sccAttempt++;
            NSLog(@"[CornflakeCapture] SCShareableContent attempt %d", sccAttempt);
            [SCShareableContent
                getShareableContentExcludingDesktopWindows:YES
                onScreenWindowsOnly:NO
                completionHandler:^(SCShareableContent* content, NSError* scErr) {
                    if (scErr || !content || content.displays.count == 0) {
                        if (sccAttempt < 2) {
                            // First failure — wait 600ms and try once more. Cheap
                            // and covers the post-grant TCC propagation lag.
                            NSLog(@"[CornflakeCapture] SCShareableContent attempt %d failed, retrying in 600ms", sccAttempt);
                            dispatch_after(
                                dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.6 * NSEC_PER_SEC)),
                                dispatch_get_main_queue(),
                                ^{ if (weakSccAttempt) weakSccAttempt(); }
                            );
                            return;
                        }

                        std::string msg;
                        if (scErr) {
                            logNSError(@"SCShareableContent preflight error (final attempt)", scErr);
                            msg = screenCaptureErrorMessage(scErr, "SCShareableContent failed");
                        } else {
                            NSLog(@"[CornflakeCapture] SCShareableContent returned no displays: content=%@ displays=%lu",
                                  content, (unsigned long)(content ? content.displays.count : 0));
                            msg = "No display available for capture";
                        }
                        cleanupAfterStartFailure();
                        fireStart(msg);
                        return;
                    }

                    SCDisplay* display = content.displays.firstObject;
                SCContentFilter* filter = [[SCContentFilter alloc]
                    initWithDisplay:display excludingWindows:@[]];

                SCStreamConfiguration* cfg = [[SCStreamConfiguration alloc] init];
                cfg.capturesAudio               = YES;
                cfg.excludesCurrentProcessAudio = NO;
                cfg.sampleRate                  = kSampleRate;
                cfg.channelCount                = kChannels;
                // Minimise video overhead — we only care about audio
                cfg.width                       = 2;
                cfg.height                      = 2;
                cfg.minimumFrameInterval        = CMTimeMake(1, 1); // 1 fps

                // Store in global so ARC keeps it alive for the duration of capture.
                // SCStream's delegate/output refs are weak — local vars get deallocated
                // after the block exits, silently killing all callbacks.
                g_handler = [[CornflakeStreamHandler alloc] init];
                g_stream = [[SCStream alloc] initWithFilter:filter
                                              configuration:cfg
                                                   delegate:g_handler];

                // SCStream requires at least one video output registered before
                // audio callbacks fire — add a no-op video handler on a low-priority queue.
                NSError* vidAddErr = nil;
                [g_stream addStreamOutput:g_handler
                                     type:SCStreamOutputTypeScreen
                        sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_BACKGROUND, 0)
                                     error:&vidAddErr];
                if (vidAddErr) {
                    logNSError(@"addStreamOutput(video) warning", vidAddErr);
                }

                NSError* addErr = nil;
                BOOL added = [g_stream
                    addStreamOutput:g_handler
                               type:SCStreamOutputTypeAudio
                  sampleHandlerQueue:dispatch_get_global_queue(QOS_CLASS_USER_INTERACTIVE, 0)
                               error:&addErr];
                if (!added || addErr) {
                    if (addErr) logNSError(@"addStreamOutput(audio) error", addErr);
                    else NSLog(@"[CornflakeCapture] addStreamOutput(audio) failed without NSError");
                    std::string msg = screenCaptureErrorMessage(addErr, "addStreamOutput failed");
                    cleanupAfterStartFailure();
                    fireStart(msg);
                    return;
                }

                [g_stream startCaptureWithCompletionHandler:^(NSError* startErr) {
                    if (startErr) {
                        logNSError(@"startCapture error", startErr);
                        std::string msg = screenCaptureErrorMessage(startErr, "startCapture failed");
                        cleanupAfterStartFailure();
                        fireStart(msg);
                        return;
                    }
                    g_capturing.store(true);
                    fireStart("");  // success
                }];
            }];
        };
        weakSccAttempt = sccAttemptBlock;
        sccAttemptBlock();
    } else {
        fireStart("macOS 13.0 or later is required");
    }

    return env.Undefined();
}

// ─── stopCapture ─────────────────────────────────────────────────────────────

static Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "stopCapture(callback) expected").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    if (!g_capturing.load()) {
        Napi::Error::New(env, "Not capturing").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    g_stopTsfn = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "stopCapture", 0, 1);
    g_stopTsfnLive.store(true);

    g_capturing.store(false);

    // Stop mic
    if (g_engine) {
        [g_engine.inputNode removeTapOnBus:0];
        [g_engine stop];
        g_engine = nil;
    }
    g_micFile.finalise();

    // Stop SCStream then finalise system audio file
    if (@available(macOS 13.0, *)) {
        if (g_stream) {
            SCStream* s = g_stream;
            g_stream = nil;
            [s stopCaptureWithCompletionHandler:^(NSError* err) {
                g_handler = nil;
                g_sysFile.finalise();
                std::string e = err ? [err.localizedDescription UTF8String] : "";
                fireStop(e, g_sysPath, g_micPath);
            }];
        } else {
            g_sysFile.finalise();
            fireStop("", g_sysPath, g_micPath);
        }
    } else {
        g_sysFile.finalise();
        fireStop("", g_sysPath, g_micPath);
    }

    return env.Undefined();
}

// ─── Module init ─────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture",  Napi::Function::New(env, StopCapture));
    return exports;
}

NODE_API_MODULE(cornflake_capture, Init)
