// CornflakeCapture.mm
// N-API addon: system audio via CoreAudio Process Tap (macOS 14.2+),
// mic via AVAudioEngine. Both streams output as 16 kHz mono 16-bit PCM WAV
// temp files.
//
// Exported:
//   startCapture(cb: (err: string|null) => void): void
//   stopCapture (cb: (err: string|null, result: {micPath,systemAudioPath}|null) => void): void
//
// System audio capture uses Apple's CoreAudio Process Tap API:
//   1. CATapDescription describes the tap (all system audio output)
//   2. AudioHardwareCreateProcessTap creates the tap
//   3. AudioHardwareCreateAggregateDevice wraps the tap into a virtual input
//   4. AVAudioEngine reads PCM from the aggregate device
//
// This avoids ScreenCaptureKit entirely. macOS surfaces this in System
// Settings → Privacy & Security → "System Audio Recording Only" (different
// TCC service from Screen Recording — kTCCServiceAudioCapture).
//
// Info.plist must include: NSAudioCaptureUsageDescription

#import <Foundation/Foundation.h>
#import <AVFoundation/AVFoundation.h>
#import <CoreMedia/CoreMedia.h>
#import <CoreAudio/CoreAudio.h>
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#import <AudioToolbox/AudioToolbox.h>
#include <napi.h>
#include <string>
#include <atomic>
#include <mutex>
#include <cstdio>
#include <cstdint>
#include <unistd.h>

// ─── WAV helpers ─────────────────────────────────────────────────────────────

static constexpr uint32_t kSampleRate = 16000;
static constexpr uint16_t kChannels   = 1;

static inline int16_t f32ToI16(float v) {
    if (v >  1.0f) v =  1.0f;
    if (v < -1.0f) v = -1.0f;
    return static_cast<int16_t>(v * 32767.0f);
}

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

static AVAudioEngine* g_micEngine = nil;
static AVAudioEngine* g_sysEngine = nil;
static AudioObjectID  g_tapID       = kAudioObjectUnknown;
static AudioObjectID  g_aggregateID = kAudioObjectUnknown;
static std::atomic<bool>         g_capturing { false };
static std::string               g_sysPath;
static std::string               g_micPath;
static PcmFile                   g_sysFile;
static PcmFile                   g_micFile;

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

// ─── TSFN call-JS callbacks ──────────────────────────────────────────────────

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

// ─── Process tap helpers (macOS 14.2+) ───────────────────────────────────────

// Fetch the tap's CFString UID via the AudioObject property API.
API_AVAILABLE(macos(14.2))
static NSString* tapUIDString(AudioObjectID tapID) {
    CFStringRef uidRef = NULL;
    UInt32 size = sizeof(uidRef);
    AudioObjectPropertyAddress addr = {
        .mSelector = kAudioTapPropertyUID,
        .mScope    = kAudioObjectPropertyScopeGlobal,
        .mElement  = kAudioObjectPropertyElementMain,
    };
    OSStatus err = AudioObjectGetPropertyData(tapID, &addr, 0, NULL, &size, &uidRef);
    if (err != noErr || !uidRef) return nil;
    return (__bridge_transfer NSString*)uidRef;
}

// Create the process tap + aggregate device wrapper. Returns 0 on success and
// writes the failure reason to errOut on failure.
API_AVAILABLE(macos(14.2))
static OSStatus setupSystemAudioTap(std::string& errOut) {
    // Exclude our own pid so Cornflake's own UI sounds aren't captured.
    NSNumber* ourPid = @(getpid());

    CATapDescription* desc = [[CATapDescription alloc] initStereoMixdownOfProcesses:@[]];
    desc.name        = @"Cornflake System Audio";
    desc.processes   = @[ ourPid ];
    desc.exclusive   = YES;   // YES + processes = mix ALL output EXCEPT listed pids
    desc.privateTap  = YES;   // not surfaced to other apps
    desc.muteBehavior = CATapUnmuted;
    desc.UUID        = [NSUUID UUID];

    OSStatus err = AudioHardwareCreateProcessTap(desc, &g_tapID);
    if (err != noErr) {
        NSLog(@"[CornflakeCapture] AudioHardwareCreateProcessTap failed: %d", (int)err);
        errOut = "AUDIO_TAP_CREATE_FAILED:" + std::to_string((int)err);
        return err;
    }
    NSLog(@"[CornflakeCapture] Created process tap, ID=%u", g_tapID);

    NSString* tapUID = tapUIDString(g_tapID);
    if (!tapUID) {
        NSLog(@"[CornflakeCapture] Tap UID lookup failed");
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
        errOut = "AUDIO_TAP_UID_FAILED";
        return -1;
    }
    NSLog(@"[CornflakeCapture] Tap UID: %@", tapUID);

    NSString* aggUID = [NSString stringWithFormat:@"app.cornflake.mac.aggregate.%@",
                        [[NSUUID UUID] UUIDString]];
    NSDictionary* aggDict = @{
        @kAudioAggregateDeviceNameKey:            @"Cornflake Aggregate",
        @kAudioAggregateDeviceUIDKey:             aggUID,
        @kAudioAggregateDeviceIsPrivateKey:       @YES,
        @kAudioAggregateDeviceIsStackedKey:       @NO,
        @kAudioAggregateDeviceTapAutoStartKey:    @YES,
        @kAudioAggregateDeviceTapListKey: @[
            @{
                @kAudioSubTapUIDKey:                 tapUID,
                @kAudioSubTapDriftCompensationKey:   @YES,
            }
        ],
    };

    err = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)aggDict, &g_aggregateID);
    if (err != noErr) {
        NSLog(@"[CornflakeCapture] AudioHardwareCreateAggregateDevice failed: %d", (int)err);
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
        errOut = "AUDIO_AGGREGATE_CREATE_FAILED:" + std::to_string((int)err);
        return err;
    }
    NSLog(@"[CornflakeCapture] Created aggregate device ID=%u", g_aggregateID);

    return noErr;
}

API_AVAILABLE(macos(14.2))
static void teardownSystemAudioTap() {
    if (g_sysEngine) {
        @try { [g_sysEngine.inputNode removeTapOnBus:0]; }
        @catch (NSException* ex) {
            NSLog(@"[CornflakeCapture] sys removeTap exception: %@", ex.reason);
        }
        [g_sysEngine stop];
        g_sysEngine = nil;
    }
    if (g_aggregateID != kAudioObjectUnknown) {
        AudioHardwareDestroyAggregateDevice(g_aggregateID);
        g_aggregateID = kAudioObjectUnknown;
    }
    if (g_tapID != kAudioObjectUnknown) {
        AudioHardwareDestroyProcessTap(g_tapID);
        g_tapID = kAudioObjectUnknown;
    }
}

static void cleanupAfterStartFailure() {
    if (g_micEngine) {
        @try { [g_micEngine.inputNode removeTapOnBus:0]; }
        @catch (NSException* ex) {
            NSLog(@"[CornflakeCapture] mic removeTap exception: %@", ex.reason);
        }
        [g_micEngine stop];
        g_micEngine = nil;
    }
    if (@available(macOS 14.2, *)) {
        teardownSystemAudioTap();
    }
    g_capturing.store(false);
    g_micFile.finalise();
    g_sysFile.finalise();
}

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

    g_startTsfn = Napi::ThreadSafeFunction::New(
        env, info[0].As<Napi::Function>(), "startCapture", 0, 1);
    g_startTsfnLive.store(true);

    // ── Mic: AVAudioEngine ────────────────────────────────────────────────────
    g_micEngine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* micIn = g_micEngine.inputNode;
    AVAudioFormat* micHwFmt = [micIn outputFormatForBus:0];
    NSLog(@"[CornflakeCapture] Mic hardware format: %@", micHwFmt);

    AVAudioFormat* targetFmt = [[AVAudioFormat alloc]
        initWithCommonFormat:AVAudioPCMFormatFloat32
                  sampleRate:kSampleRate
                    channels:kChannels
                 interleaved:NO];

    __block AVAudioConverter* micConverter =
        [[AVAudioConverter alloc] initFromFormat:micHwFmt toFormat:targetFmt];

    [micIn installTapOnBus:0 bufferSize:4096 format:micHwFmt
                     block:^(AVAudioPCMBuffer* hwBuf, AVAudioTime*) {
        if (!g_capturing.load()) return;

        double ratio = targetFmt.sampleRate / micHwFmt.sampleRate;
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

    NSError* micEngineErr = nil;
    [g_micEngine startAndReturnError:&micEngineErr];
    if (micEngineErr) {
        NSLog(@"[CornflakeCapture] Mic AVAudioEngine error: %@", micEngineErr.localizedDescription);
        // Non-fatal — JS handles mic permission separately.
    }

    // ── System audio: CoreAudio Process Tap ──────────────────────────────────
    if (@available(macOS 14.2, *)) {
        std::string tapErr;
        OSStatus tapStatus = setupSystemAudioTap(tapErr);
        if (tapStatus != noErr) {
            cleanupAfterStartFailure();
            fireStart(tapErr);
            return env.Undefined();
        }

        g_sysEngine = [[AVAudioEngine alloc] init];
        AVAudioInputNode* sysIn = g_sysEngine.inputNode;

        // Point the system-audio engine's input AudioUnit at our aggregate device.
        AudioUnit sysAU = [sysIn audioUnit];
        AudioDeviceID devID = g_aggregateID;
        OSStatus setDevErr = AudioUnitSetProperty(sysAU,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global, 0,
            &devID, sizeof(devID));
        if (setDevErr != noErr) {
            NSLog(@"[CornflakeCapture] Failed to set input device on sys AU: %d", (int)setDevErr);
            cleanupAfterStartFailure();
            fireStart("AUDIO_SET_DEVICE_FAILED:" + std::to_string((int)setDevErr));
            return env.Undefined();
        }

        AVAudioFormat* sysHwFmt = [sysIn outputFormatForBus:0];
        NSLog(@"[CornflakeCapture] System audio hardware format: %@", sysHwFmt);

        __block AVAudioConverter* sysConverter =
            [[AVAudioConverter alloc] initFromFormat:sysHwFmt toFormat:targetFmt];

        [sysIn installTapOnBus:0 bufferSize:4096 format:sysHwFmt
                         block:^(AVAudioPCMBuffer* hwBuf, AVAudioTime*) {
            if (!g_capturing.load()) return;

            double ratio = targetFmt.sampleRate / sysHwFmt.sampleRate;
            AVAudioFrameCount outFrames =
                static_cast<AVAudioFrameCount>(ceil(hwBuf.frameLength * ratio)) + 8;
            AVAudioPCMBuffer* outBuf =
                [[AVAudioPCMBuffer alloc] initWithPCMFormat:targetFmt frameCapacity:outFrames];

            __block BOOL inputConsumed = NO;
            NSError* cvtErr = nil;
            [sysConverter convertToBuffer:outBuf error:&cvtErr
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
                g_sysFile.writeSamples(outBuf.floatChannelData[0], outBuf.frameLength);
        }];

        NSError* sysEngineErr = nil;
        [g_sysEngine startAndReturnError:&sysEngineErr];
        if (sysEngineErr) {
            NSLog(@"[CornflakeCapture] Sys AVAudioEngine error: %@", sysEngineErr.localizedDescription);
            std::string msg = "AUDIO_ENGINE_FAILED:";
            msg += [sysEngineErr.localizedDescription UTF8String];
            cleanupAfterStartFailure();
            fireStart(msg);
            return env.Undefined();
        }

        g_capturing.store(true);
        fireStart("");  // success
    } else {
        cleanupAfterStartFailure();
        fireStart("macOS 14.2 or later is required for system audio capture");
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
    if (g_micEngine) {
        @try { [g_micEngine.inputNode removeTapOnBus:0]; }
        @catch (NSException* ex) {
            NSLog(@"[CornflakeCapture] stop: mic removeTap exception: %@", ex.reason);
        }
        [g_micEngine stop];
        g_micEngine = nil;
    }
    g_micFile.finalise();

    // Stop system audio
    if (@available(macOS 14.2, *)) {
        teardownSystemAudioTap();
    }
    g_sysFile.finalise();

    fireStop("", g_sysPath, g_micPath);
    return env.Undefined();
}

// ─── Module init ─────────────────────────────────────────────────────────────

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture",  Napi::Function::New(env, StopCapture));
    return exports;
}

NODE_API_MODULE(cornflake_capture, Init)
